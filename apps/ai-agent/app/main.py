from fastapi import FastAPI
from .router import router

app = FastAPI(title='Grabit AI Agent')
app.include_router(router)
