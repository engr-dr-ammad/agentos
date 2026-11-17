import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy import text

from .api import agents, analytics, approvals, auth, billing, integrations, knowledge, org, tasks, workflows
from .config import get_settings
from .db import engine
from .engine.templating import TemplateError

settings = get_settings()
log = logging.getLogger("agentos")
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
CSRF_EXEMPT = ("/api/v1/hooks/", "/api/v1/billing/webhook")


@asynccontextmanager
async def lifespan(app: FastAPI):
    stop = asyncio.Event()
    task = None
    if settings.inline_worker:
        from .engine.worker import main as worker_main

        task = asyncio.create_task(worker_main(stop))
    yield
    stop.set()
    if task:
        await task
    await engine.dispose()


app = FastAPI(title="AgentOS API", version="0.1.0", lifespan=lifespan, docs_url="/api/docs",
              openapi_url="/api/openapi.json", redoc_url=None,
              description="AI workforce management platform. All endpoints are tenant-scoped.")


@app.middleware("http")
async def security(request: Request, call_next):
    # CSRF: state-changing requests authenticated by cookie must carry a custom header, which
    # browsers cannot send cross-site without a CORS preflight (and no CORS is enabled).
    if (request.method not in SAFE_METHODS and request.url.path.startswith("/api/")
            and not request.url.path.startswith(CSRF_EXEMPT)
            and "agentos_session" in request.cookies
            and request.headers.get("x-agentos-csrf") != "1"):
        return JSONResponse({"detail": "Missing CSRF header"}, status_code=403)
    resp = await call_next(request)
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("X-Frame-Options", "DENY")
    resp.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    resp.headers.setdefault("Cache-Control", "no-store")
    return resp


@app.exception_handler(TemplateError)
async def template_error(_: Request, exc: TemplateError):
    return JSONResponse({"detail": str(exc)}, status_code=422)


@app.exception_handler(RequestValidationError)
async def validation_error(_: Request, exc: RequestValidationError):
    msgs = []
    for e in exc.errors():
        loc = ".".join(str(p) for p in e["loc"] if p not in ("body", "query", "path"))
        msgs.append(f"{loc}: {e['msg']}" if loc else e["msg"])
    return JSONResponse({"detail": "; ".join(msgs), "errors": jsonable(exc.errors())}, status_code=422)


def jsonable(v):
    from fastapi.encoders import jsonable_encoder

    return jsonable_encoder(v, custom_encoder={Exception: str})


API = "/api/v1"
for r in (auth.router, org.router, agents.router, workflows.router, approvals.router, tasks.router,
          knowledge.router, integrations.router, analytics.router, billing.router):
    app.include_router(r, prefix=API)
app.include_router(workflows.hooks, prefix=API)


@app.get("/api/health", tags=["health"])
async def health():
    async with engine.connect() as c:
        await c.execute(text("SELECT 1"))
    return {"status": "ok", "version": app.version}
