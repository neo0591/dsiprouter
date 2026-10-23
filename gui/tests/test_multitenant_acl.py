# Local isolation checks for the multi-tenant primitives. No MySQL required.
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from flask import Flask, session
from werkzeug.exceptions import Forbidden

_src = open(os.path.join(os.path.dirname(__file__), '..', 'modules', 'api', 'acl.py'), encoding='utf-8').read()
_src = _src.split('# ───────────────────────────── HTTP API')[0]
acl = type(sys)('acl')
exec(compile(_src, 'acl.py', 'exec'), acl.__dict__)


class _Result:
    def __init__(self, row):
        self._row = row

    def first(self):
        return self._row


class FakeDB:
    def __init__(self, owner):
        self.owner = owner

    def execute(self, _sql, params=None):
        imei = (params or {}).get('imei')
        if imei in self.owner:
            return _Result((self.owner[imei],))
        return _Result(None)


def _app():
    app = Flask(__name__)
    app.secret_key = 'mt-test'
    return app


def test_platform_admin_sees_all_and_stamps_default():
    app = _app()
    acl._DEFAULT_CID = 7
    with app.test_request_context():
        session['is_platform_admin'] = True
        assert acl.current_customer_id() is None
        assert acl.scoped_imei('c') == ('', {})
        assert acl.stamp_customer() == 7
        acl.require_owned_imei(FakeDB({}), '999')


def test_tenant_write_and_read_scope():
    app = _app()
    db = FakeDB({'111': 2, '222': 3})
    with app.test_request_context():
        session['is_platform_admin'] = False
        session['customer_id'] = 2
        acl.require_owned_imei(db, '111')
        try:
            acl.require_owned_imei(db, '222')
            raise AssertionError('cross-tenant write should be forbidden')
        except Forbidden:
            pass
        sql, params = acl.scoped_imei('c')
        assert 'EXISTS' in sql and 'c.imei' in sql
        assert params['__cid'] == 2
        sql2, _ = acl.scoped_imei('s', 'username')
        assert 's.username' in sql2


def test_unknown_device_is_forbidden_for_tenant():
    app = _app()
    with app.test_request_context():
        session['is_platform_admin'] = False
        session['customer_id'] = 2
        try:
            acl.require_owned_imei(FakeDB({}), '000')
            raise AssertionError('missing device should be forbidden')
        except Forbidden:
            pass


if __name__ == '__main__':
    test_platform_admin_sees_all_and_stamps_default()
    test_tenant_write_and_read_scope()
    test_unknown_device_is_forbidden_for_tenant()
    print('multitenant acl checks passed')
