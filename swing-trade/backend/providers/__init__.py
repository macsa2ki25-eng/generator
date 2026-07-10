from .. import config


def get_provider():
    if config.PROVIDER == "demo":
        from .demo_provider import DemoProvider

        return DemoProvider()
    from .yfinance_provider import YFinanceProvider

    return YFinanceProvider()
