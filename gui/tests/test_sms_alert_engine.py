# -*- coding: utf-8 -*-
"""对齐 design/__qa__/engine.test.js：classify_sms 规则引擎单测。"""
from __future__ import annotations

import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from modules.api.ufi_sms_alert import DEFAULT_RULE_CFG, classify_sms  # noqa: E402


def _cfg(**kw):
    c = {
        'thresholds': dict(DEFAULT_RULE_CFG['thresholds']),
        'p0Enabled': True,
        'p12Enabled': True,
        'overageEnabled': True,
        'overageThreshold': 50.0,
        'billingAlert': False,
        'unknownPortPolicy': 'suspect',
    }
    c.update(kw)
    return c


def lvl(content, sender, cfg=None):
    return classify_sms(content, sender, cfg)['level']


def test_recover_owed_zero():
    r = classify_sms(
        '【充值到账提醒】尊敬的客户您好，20日15时28分您的号码成功缴费100.00元，'
        '您的可用余额为116.67元，待返还余额为0.00元，欠费金额为0.00元。',
        '10086',
    )
    assert r['level'] == 'RECOVERED'


def test_future_stop_not_p0():
    r = classify_sms('尊敬的客户，当您的余额为0时我公司将停止服务，请及时充值。', '10086')
    assert r['level'] != 'P0'
    assert r['level'] == 'P2'


def test_overdraft_quota_is_p2():
    r = classify_sms(
        '尊敬的客户，至10月21日20时，您的账户余额为8.60元。您是3星级客户，在48小时内可享受透支额度为30.00元。'
        '欠费停机将影响您的通信畅通，建议您及时预存话费。',
        '10086',
    )
    assert r['level'] != 'P1'
    assert r['level'] == 'P2'


def test_overage_p3():
    r = classify_sms(
        '【超套餐提醒】截至07月20日20时35分，您本月移动数据流量已使用27.26GB，'
        '超出套餐流量已达到511.95MB，套餐外流量总费用147.66元。',
        '10086',
    )
    assert r['level'] == 'P3'
    ov = next((a for a in r['amounts'] if a['name'] == '套外费用'), None)
    assert ov and ov['value'] == 147.66


def test_flow_ignored():
    r = classify_sms(
        '【中国联通】流量用尽提醒：截至07月30日16时18分，您当月套餐内的国内通用流量已用4.000GB，'
        '剩余0.0MB；当前套餐套外流量资费为1元/GB日租宝（当日有效，自动叠加）。',
        '10010',
    )
    assert r['level'] == 'IGNORED'


def test_suspend_p0():
    assert lvl('【中国电信】您号码 189****4567 已欠费 8.60 元并暂停服务，充值后 10 分钟内自动复机。', '10000') == 'P0'


def test_port_whitelist_cu():
    r = classify_sms('尊敬的客户，您的话费余额仅剩5.20元，请及时充值。', '10010')
    assert r['carrier'] == '中国联通'
    assert r['whitelisted'] is True
    assert r['level'] == 'P2'


def test_p2_synonyms():
    assert lvl('尊敬的客户，您的余额偏低，请关注。', '10086') == 'P2'
    assert lvl('尊敬的客户，您的余额告急，请尽快缴费。', '10086') == 'P2'
    assert lvl('尊敬的客户，请及时预存话费，以免影响通信。', '10086') == 'P2'


def test_neg_balance_p0():
    r = classify_sms(
        '【话费提醒】尊敬的全球通客户，您好！截止20日20时36分您的账户余额-31.79元，本月可透支额度50.00元。',
        '10086',
    )
    assert r['level'] == 'P0'
    bal = next((a for a in r['amounts'] if a['name'] == '账户余额'), None)
    assert bal and bal['value'] == -31.79


def test_arrears_preview_p1():
    r = classify_sms(
        '尊敬的客户，至10月21日20时，您已欠费12.30元。您是3星级客户，在24小时内可享受透支额度为30.00元，'
        '超出时间或透支额度后将执行主叫停机，6小时后将进行欠费停机。为避免影响您的使用，建议您尽快交纳话费。',
        '10086',
    )
    assert r['level'] == 'P1'


def test_unknown_port_suspect():
    r = classify_sms(
        '【移动通信】尊敬的客户，您的号码已欠费35.00元即将停机，请立即登录 http://cz-pay.example 充值，逾期将影响使用。',
        '1065712345678',
    )
    assert r['level'] == 'SUSPECT'
    assert r['whitelisted'] is False
    assert any('白名单' in n for n in r['notes'])


def test_carrier_thresholds():
    r = classify_sms(
        '【中国电信】您的账户余额为 18.50 元，低于 20 元，为避免欠费带来的不便，请及时充值缴费。',
        '10000',
    )
    assert r['level'] == 'P2'
    assert any('20' in h and '低于' in h for h in r['hits'])


def test_owed_will_affect_not_p0():
    assert lvl(
        '尊敬的客户，截至07月17日09时，您的话费余额为6.43元，欠费停机将影响您的使用和星级，请及时交费。',
        '10001',
    ) == 'P2'


def test_will_pause_is_p1():
    r = classify_sms('尊敬的客户，您的号码已欠费，将于24小时后暂停服务，请及时充值。', '10086')
    assert r['level'] != 'P0'
    assert r['level'] == 'P1'


def test_p0_switch_downgrade():
    text = '您的号码已欠费12.30元并已停机，请充值复机。'
    assert lvl(text, '10086') == 'P0'
    assert lvl(text, '10086', _cfg(p0Enabled=False)) == 'P1'


def test_p0_switch_ignore_neg_bal():
    text = '【话费提醒】尊敬的全球通客户，您好！截止20日20时36分您的账户余额-31.79元，本月可透支额度50.00元。'
    assert lvl(text, '10086') == 'P0'
    assert lvl(text, '10086', _cfg(p0Enabled=False)) == 'IGNORED'


def test_boundaries_no_throw():
    for content, sender in [
        ('', '10086'),
        ('12345', '10086'),
        ('a' * 50000 + '欠费停机', '10086'),
        ('账户余额１２３元，余额不足，请及时充值。', '10086'),
        (None, None),
        ('  😀😀  \n\t  ', '10010'),
        ('余额不足', ''),
        ('您的余额--3.5.6元，余额告急', '10086'),
    ]:
        r = classify_sms(content, sender)
        assert r['level'] in ('P0', 'P1', 'P2', 'P3', 'RECOVERED', 'SUSPECT', 'IGNORED')
        assert 5 <= r['confidence'] <= 99


if __name__ == '__main__':
    import traceback
    tests = [v for k, v in list(globals().items()) if k.startswith('test_') and callable(v)]
    ok = fail = 0
    for fn in tests:
        try:
            fn()
            ok += 1
            print('  ✔', fn.__name__)
        except Exception as ex:
            fail += 1
            print('  ✘', fn.__name__, '-', ex)
            traceback.print_exc()
    print('通过 {} / 失败 {}'.format(ok, fail))
    raise SystemExit(1 if fail else 0)
