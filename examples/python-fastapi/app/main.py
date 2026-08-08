from fastapi import FastAPI

from app.db import get_session

app = FastAPI()


@app.get("/healthz")
async def healthz():
    return {"status": "ok"}


@app.get("/orders/{order_id}")
async def get_order(order_id: int):
    async with get_session() as session:
        return await session.get_order(order_id)
