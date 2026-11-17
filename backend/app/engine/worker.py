"""Background worker: claims jobs (SKIP LOCKED) and fires schedules.

Pending approvals park their job until the approval deadline, so expiry needs no global scan.

Run with `python -m app.engine.worker`. Multiple workers can run concurrently.
"""

import asyncio
import logging
import signal
from datetime import UTC, datetime, timedelta
from uuid import UUID
from zoneinfo import ZoneInfo

from croniter import croniter
from sqlalchemy import delete, select, text, update

from ..config import get_settings
from ..db import SessionLocal, tenant_session
from ..models import JobQueue, Schedule, Task, Workflow
from .executor import RunResult, run_execution

log = logging.getLogger("agentos.worker")
settings = get_settings()
LEASE = timedelta(minutes=15)


def next_run(cron: str, tz: str, after: datetime | None = None) -> datetime:
    zone = ZoneInfo(tz or "UTC")
    base = (after or datetime.now(UTC)).astimezone(zone)
    return croniter(cron, base).get_next(datetime).astimezone(UTC)


async def claim(n: int) -> list[tuple[int, UUID, UUID]]:
    async with SessionLocal() as db:
        rows = (await db.execute(text("""
            UPDATE job_queue SET locked_until = now() + make_interval(secs => :lease), attempts = attempts + 1
            WHERE id IN (
              SELECT id FROM job_queue
              WHERE run_after <= now() AND (locked_until IS NULL OR locked_until < now())
              ORDER BY run_after LIMIT :n FOR UPDATE SKIP LOCKED)
            RETURNING id, execution_id, org_id"""), {"n": n, "lease": LEASE.total_seconds()})).all()
        await db.commit()
        return [(r.id, r.execution_id, r.org_id) for r in rows]


async def process(job_id: int, execution_id: UUID, org_id: UUID) -> RunResult:
    try:
        async with tenant_session(org_id) as db:
            result = await run_execution(db, execution_id)
    except Exception:
        log.exception("execution %s crashed; will retry", execution_id)
        result = RunResult("requeue", datetime.now(UTC) + timedelta(seconds=30))
    async with SessionLocal() as db:
        if result.action == "requeue":
            await db.execute(update(JobQueue).where(JobQueue.id == job_id)
                             .values(run_after=result.run_after, locked_until=None))
        else:
            await db.execute(delete(JobQueue).where(JobQueue.id == job_id))
        await db.commit()
    return result


async def fire_schedules() -> int:
    """Start executions for due schedules (workflow schedules and recurring tasks)."""
    from ..api.workflows import start_execution

    fired = 0
    async with SessionLocal() as db:
        due = (await db.scalars(select(Schedule).where(Schedule.enabled, Schedule.next_run_at <= datetime.now(UTC))
                                .with_for_update(skip_locked=True).limit(50))).all()
        for s in due:
            s.next_run_at = next_run(s.cron, s.timezone)
            async with tenant_session(s.org_id) as tdb:
                try:
                    if s.workflow_id:
                        wf = await tdb.get(Workflow, s.workflow_id)
                        if wf and wf.status == "active" and wf.published_version:
                            await start_execution(tdb, wf.org_id, wf, input={"scheduled_at": datetime.now(UTC)
                                                                              .isoformat()}, trigger_type="schedule")
                    elif s.task_id:
                        from ..api.tasks import run_task

                        task = await tdb.get(Task, s.task_id)
                        if task and task.status not in ("Cancelled", "Expired", "Draft"):
                            await run_task(tdb, task, actor=None, recurring=True)
                    await tdb.commit()
                    fired += 1
                except Exception:
                    log.exception("schedule %s failed to fire", s.id)
        await db.commit()
    return fired


async def main(stop: asyncio.Event | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    stop = stop or asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except (NotImplementedError, RuntimeError):
            pass
    running: set[asyncio.Task] = set()
    last_housekeeping = datetime.min.replace(tzinfo=UTC)
    log.info("worker started (concurrency=%s)", settings.worker_concurrency)
    while not stop.is_set():
        try:
            if datetime.now(UTC) - last_housekeeping > timedelta(seconds=30):
                last_housekeeping = datetime.now(UTC)
                await fire_schedules()
            free = settings.worker_concurrency - len(running)
            jobs = await claim(free) if free > 0 else []
            for job in jobs:
                t = asyncio.create_task(process(*job))
                running.add(t)
                t.add_done_callback(running.discard)
        except Exception:
            log.exception("worker loop error")
            jobs = []
        if not jobs:
            try:
                await asyncio.wait_for(stop.wait(), timeout=settings.worker_poll_seconds)
            except TimeoutError:
                pass
    if running:
        await asyncio.gather(*running, return_exceptions=True)
    log.info("worker stopped")


async def drain(max_rounds: int = 100) -> int:
    """Process all due jobs synchronously (used by tests and the inline dev runner)."""
    n = 0
    for _ in range(max_rounds):
        jobs = await claim(10)
        if not jobs:
            break
        for job in jobs:
            await process(*job)
            n += 1
    return n


if __name__ == "__main__":
    asyncio.run(main())
