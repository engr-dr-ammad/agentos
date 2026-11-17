import uuid

import httpx

from app.main import app


class Client(httpx.AsyncClient):
    def __init__(self):
        super().__init__(transport=httpx.ASGITransport(app=app), base_url="http://test/api/v1",
                         headers={"x-agentos-csrf": "1"})

    async def ok(self, method: str, url: str, expect: int | tuple = (200, 201, 202), **kw):
        r = await self.request(method, url, **kw)
        exp = expect if isinstance(expect, tuple) else (expect,)
        assert r.status_code in exp, f"{method} {url} -> {r.status_code}: {r.text}"
        return r.json() if r.content and r.headers.get("content-type", "").startswith("application/json") else r


async def signup(company: str = "Acme") -> tuple[Client, dict]:
    c = Client()
    email = f"{uuid.uuid4().hex[:10]}@example.com"
    data = await c.ok("POST", "/auth/register", json={"email": email, "password": "correct-horse-42",
                                                      "name": "Owner", "company_name": company})
    data["email"] = email
    return c, data
