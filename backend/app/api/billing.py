"""Subscriptions and usage. Stripe is optional: without keys the app runs in billing sandbox mode."""

from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import func, select

from ..config import get_settings
from ..db import SessionLocal, tenant_session
from ..deps import Owner, Viewer, audit
from ..llm.service import month_start
from ..models import Agent, Document, Invoice, Membership, Organization, Subscription, UsageEvent, Workflow
from ..plans import PLANS

router = APIRouter(prefix="/billing", tags=["billing"])
settings = get_settings()


def _stripe():
    if not settings.stripe_secret_key:
        return None
    import stripe

    stripe.api_key = settings.stripe_secret_key
    return stripe


PRICE_IDS = {"business": lambda: settings.stripe_price_business,
             "professional": lambda: settings.stripe_price_professional}


@router.get("")
async def billing(ctx: Viewer):
    db, org_id = ctx.db, ctx.org_id
    org = await db.get(Organization, org_id)
    sub = await db.scalar(select(Subscription).where(Subscription.org_id == org_id))
    cnt = lambda m: db.scalar(select(func.count()).select_from(m).where(m.org_id == org_id))  # noqa: E731
    usage_month = (await db.execute(select(
        func.coalesce(func.sum(UsageEvent.cost_usd), 0), func.coalesce(func.sum(UsageEvent.tokens_in), 0),
        func.coalesce(func.sum(UsageEvent.tokens_out), 0)).where(
        UsageEvent.org_id == org_id, UsageEvent.created_at >= month_start()))).one()
    execs = await db.scalar(select(func.count()).select_from(UsageEvent).where(
        UsageEvent.org_id == org_id, UsageEvent.kind == "execution", UsageEvent.created_at >= month_start()))
    invoices = (await db.scalars(select(Invoice).where(Invoice.org_id == org_id)
                                 .order_by(Invoice.created_at.desc()).limit(24))).all()
    return {
        "plan": org.plan, "plans": PLANS, "status": sub.status if sub else "active",
        "current_period_end": sub.current_period_end if sub else None,
        "stripe_enabled": bool(settings.stripe_secret_key),
        "usage": {"agents": await cnt(Agent), "workflows": await cnt(Workflow), "documents": await cnt(Document),
                  "members": await db.scalar(select(func.count()).select_from(Membership)
                                             .where(Membership.org_id == org_id)),
                  "executions_this_month": execs, "ai_cost_this_month_usd": float(usage_month[0]),
                  "tokens_in": int(usage_month[1]), "tokens_out": int(usage_month[2])},
        "invoices": [{"id": i.id, "amount": i.amount_cents / 100, "currency": i.currency, "status": i.status,
                      "url": i.hosted_url, "created_at": i.created_at} for i in invoices],
        "note": "AI model costs are billed by your own model provider; AgentOS meters them for budgets.",
    }


class CheckoutIn(BaseModel):
    plan: str


@router.post("/checkout")
async def checkout(body: CheckoutIn, ctx: Owner):
    if body.plan not in PLANS:
        raise HTTPException(404, "Unknown plan")
    stripe = _stripe()
    if stripe is None:
        if settings.is_production:
            raise HTTPException(503, "Billing is not configured")
        # Sandbox: switch plan directly so limits can be explored (clearly not a payment).
        org = await ctx.db.get(Organization, ctx.org_id)
        org.plan = body.plan
        sub = await ctx.db.scalar(select(Subscription).where(Subscription.org_id == ctx.org_id))
        sub.plan = body.plan
        await ctx.audit("billing.plan_changed_sandbox", "subscription", sub.id, plan=body.plan)
        await ctx.db.commit()
        return {"sandbox": True, "plan": body.plan}
    price = PRICE_IDS.get(body.plan, lambda: None)()
    if not price:
        raise HTTPException(400, "This plan is not self-serve. Contact sales.")
    sub = await ctx.db.scalar(select(Subscription).where(Subscription.org_id == ctx.org_id))
    session = stripe.checkout.Session.create(
        mode="subscription", line_items=[{"price": price, "quantity": 1}],
        customer=sub.stripe_customer_id or None, customer_email=None if sub.stripe_customer_id else ctx.user.email,
        client_reference_id=str(ctx.org_id), metadata={"org_id": str(ctx.org_id), "plan": body.plan},
        success_url=f"{settings.public_url}/app/billing?status=success",
        cancel_url=f"{settings.public_url}/app/billing?status=cancelled")
    return {"url": session.url}


@router.post("/portal")
async def portal(ctx: Owner):
    stripe = _stripe()
    sub = await ctx.db.scalar(select(Subscription).where(Subscription.org_id == ctx.org_id))
    if stripe is None or not sub.stripe_customer_id:
        raise HTTPException(400, "No billing account yet")
    s = stripe.billing_portal.Session.create(customer=sub.stripe_customer_id,
                                             return_url=f"{settings.public_url}/app/billing")
    return {"url": s.url}


@router.post("/webhook", include_in_schema=False)
async def stripe_webhook(request: Request):
    stripe = _stripe()
    if stripe is None or not settings.stripe_webhook_secret:
        raise HTTPException(404)
    payload = await request.body()
    try:
        event = stripe.Webhook.construct_event(payload, request.headers.get("stripe-signature", ""),
                                               settings.stripe_webhook_secret)
    except Exception as e:
        raise HTTPException(400, "Invalid signature") from e
    obj = event["data"]["object"]
    async with SessionLocal() as db:
        if event["type"] == "checkout.session.completed":
            org_id = obj["metadata"]["org_id"]
            sub = await db.scalar(select(Subscription).where(Subscription.org_id == org_id))
            org = await db.get(Organization, org_id)
            sub.plan = org.plan = obj["metadata"]["plan"]
            sub.stripe_customer_id, sub.stripe_subscription_id = obj.get("customer"), obj.get("subscription")
            sub.status = "active"
            await db.commit()
        elif event["type"] in ("customer.subscription.updated", "customer.subscription.deleted"):
            sub = await db.scalar(select(Subscription).where(Subscription.stripe_subscription_id == obj["id"]))
            if sub:
                sub.status = obj["status"]
                if obj.get("current_period_end"):
                    sub.current_period_end = datetime.fromtimestamp(obj["current_period_end"], UTC)
                if event["type"].endswith("deleted"):
                    org = await db.get(Organization, sub.org_id)
                    sub.plan = org.plan = "starter"
                await db.commit()
        elif event["type"] in ("invoice.paid", "invoice.payment_failed", "invoice.finalized"):
            sub = await db.scalar(select(Subscription).where(Subscription.stripe_customer_id == obj.get("customer")))
            if sub:
                org_id = sub.org_id
                async with tenant_session(org_id) as tdb:
                    inv = await tdb.scalar(select(Invoice).where(Invoice.stripe_invoice_id == obj["id"]))
                    inv = inv or Invoice(org_id=org_id, stripe_invoice_id=obj["id"], amount_cents=0, currency="eur",
                                         status="draft")
                    inv.amount_cents, inv.currency = obj.get("amount_due", 0), obj.get("currency", "eur")
                    inv.status, inv.hosted_url = obj.get("status", "open"), obj.get("hosted_invoice_url")
                    tdb.add(inv)
                    await audit(tdb, org_id, f"billing.{event['type']}", "invoice", obj["id"])
                    await tdb.commit()
    return {"received": True}
