import os
from contextlib import asynccontextmanager

from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

# Credentials come from Secrets Manager, injected by the task execution role.
engine = create_async_engine(os.environ["DATABASE_URL"], pool_size=5)
SessionLocal = async_sessionmaker(engine)


@asynccontextmanager
async def get_session():
    async with SessionLocal() as session:
        yield session
