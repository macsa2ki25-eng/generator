"""アプリのエントリーポイント。  python -m backend.main で起動。"""
import threading
import webbrowser

import uvicorn
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from . import api, config, database

database.init()

app = FastAPI(title="スイングトレード分析", docs_url=None, redoc_url=None)
app.include_router(api.router, prefix="/api")
app.mount("/", StaticFiles(directory=str(config.FRONTEND_DIR), html=True), name="static")


def main():
    url = f"http://{config.HOST}:{config.PORT}"
    print(f"\n  スイングトレード分析  {url}")
    print(f"  データソース: {api.provider.name}{'(デモデータ)' if api.provider.is_demo else ''}\n")
    if config.OPEN_BROWSER:
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()
    uvicorn.run(app, host=config.HOST, port=config.PORT, log_level="warning")


if __name__ == "__main__":
    main()
