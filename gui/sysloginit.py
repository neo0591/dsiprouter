import logging
import settings
from logging.handlers import SysLogHandler
from copy import copy

# Historical DSIP_LOG_LEVEL stores a syslog priority (0-7), not a Python level.
_SYSLOG_TO_PY = {
    0: logging.CRITICAL,
    1: logging.CRITICAL,
    2: logging.CRITICAL,
    3: logging.WARNING,
    4: logging.WARNING,
    5: logging.INFO,
    6: logging.INFO,
    7: logging.DEBUG,
}


def py_log_level(level=None):
    """Map stored DSIP_LOG_LEVEL to a logging level that will not dump SQL DEBUG."""
    if level is None:
        level = getattr(settings, 'DSIP_LOG_LEVEL', logging.INFO)
    try:
        n = int(level)
    except (TypeError, ValueError):
        return logging.INFO
    if n <= 7:
        return _SYSLOG_TO_PY.get(n, logging.INFO)
    return n


def initSyslogLogger():
    """
    Configure syslog loggers
    :return:    syslog log handler
    """
    # close any zombie handlers for root logger
    for handler in copy(logging.getLogger().handlers):
        logging.getLogger().removeHandler(handler)
        handler.close()

    # create our own custom formatter and handler for syslog
    log_formatter = logging.Formatter('[%(asctime)s] [%(process)d->%(thread)d] [%(levelname)s]: %(message)s',
                                      datefmt='%Y-%m-%d %H:%M:%S')
    level = py_log_level()
    log_handler = logging.handlers.SysLogHandler(address="/dev/log", facility=settings.DSIP_LOG_FACILITY)
    log_handler.setLevel(level)
    log_handler.setFormatter(log_formatter)

    # set log handler for our dsiprouter app
    logging.getLogger().setLevel(level)
    logging.getLogger().addHandler(log_handler)

    # redirect stderr and stdout to syslog
    # if not settings.DEBUG:
    #     sys.stderr = StreamLogger(level=logging.WARNING)
    #     sys.stdout = StreamLogger(level=logging.DEBUG)

    return log_handler

# import this file to setup logging
# syslog handler created globally
# syslog_handler = initSyslogLogger()
