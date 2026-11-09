def __getattr__(name):
    return lambda *args, **kwargs: None
