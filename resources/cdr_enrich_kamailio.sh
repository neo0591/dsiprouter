#!/bin/bash
# Enrich Kamailio CDR accounting for UFI/X-VOLTE bridge calls.
# - adds orig_caller / orig_callee columns on acc
# - stores X-VOLTE / original dialed numbers into dlg_var + db_extra
# - sets calltype on LOCATION path (carrier/PBX -> registered endpoint)
set -euo pipefail

CFG=/etc/kamailio/kamailio.cfg
BACKUP="/etc/kamailio/kamailio.cfg.bak.cdr-enrich.$(date +%Y%m%d%H%M%S)"
cp -a "$CFG" "$BACKUP"
echo "backup: $BACKUP"

# --- DB columns ---
/opt/dsiprouter/venv/bin/python - <<'PY'
import os, sys
os.chdir('/opt/dsiprouter/gui')
sys.path.insert(0, '/etc/dsiprouter/gui')
sys.path.insert(0, '/opt/dsiprouter/gui')
from database import createSessionObjects, startSession
from sqlalchemy import text
createSessionObjects()
db = startSession()
try:
    cols = {r[0] for r in db.execute(text('SHOW COLUMNS FROM acc')).all()}
    alters = []
    if 'orig_caller' not in cols:
        alters.append("ADD COLUMN orig_caller varchar(128) NOT NULL DEFAULT '' AFTER dst_gwgroupid")
    if 'orig_callee' not in cols:
        alters.append("ADD COLUMN orig_callee varchar(128) NOT NULL DEFAULT '' AFTER orig_caller")
    if alters:
        db.execute(text(f"ALTER TABLE acc {', '.join(alters)}"))
        db.commit()
        print('altered acc:', alters)
    else:
        print('acc columns already present')
finally:
    db.close()
PY

python3 - <<'PY'
from pathlib import Path
cfg_path = Path('/etc/kamailio/kamailio.cfg')
text = cfg_path.read_text()

old_extra = '''modparam("acc", "log_extra",
	"src_user=$fU;src_domain=$fd;src_ip=$si;dst_ouser=$tU;dst_user=$rU;dst_domain=$rd;"
	"calltype=$avp(calltype);src_gwgroupid=$dlg_var(src_gwgroupid);dst_gwgroupid=$dlg_var(dst_gwgroupid)")'''
new_extra = '''modparam("acc", "log_extra",
	"src_user=$fU;src_domain=$fd;src_ip=$si;dst_ouser=$tU;dst_user=$rU;dst_domain=$rd;"
	"calltype=$avp(calltype);src_gwgroupid=$dlg_var(src_gwgroupid);dst_gwgroupid=$dlg_var(dst_gwgroupid);"
	"orig_caller=$dlg_var(orig_caller);orig_callee=$dlg_var(orig_callee)")'''
if 'orig_caller=$dlg_var(orig_caller)' not in text:
    if old_extra not in text:
        raise SystemExit('log_extra block not found')
    text = text.replace(old_extra, new_extra, 1)
    print('patched log_extra')
else:
    print('log_extra already patched')

old_db = '''modparam("acc", "db_extra",
	"src_user=$fU;src_domain=$fd;src_ip=$si;dst_ouser=$tU;dst_user=$rU;dst_domain=$rd;"
	"calltype=$avp(calltype);src_gwgroupid=$dlg_var(src_gwgroupid);dst_gwgroupid=$dlg_var(dst_gwgroupid)")'''
new_db = '''modparam("acc", "db_extra",
	"src_user=$fU;src_domain=$fd;src_ip=$si;dst_ouser=$tU;dst_user=$rU;dst_domain=$rd;"
	"calltype=$avp(calltype);src_gwgroupid=$dlg_var(src_gwgroupid);dst_gwgroupid=$dlg_var(dst_gwgroupid);"
	"orig_caller=$dlg_var(orig_caller);orig_callee=$dlg_var(orig_callee)")'''
if 'orig_caller=$dlg_var(orig_caller)' not in text.split('db_extra')[1][:500] if 'db_extra' in text else True:
    pass
if old_db in text:
    text = text.replace(old_db, new_db, 1)
    print('patched db_extra')
elif 'orig_caller=$dlg_var(orig_caller)' in text:
    print('db_extra already patched')
else:
    raise SystemExit('db_extra block not found')

# Capture original To/From early in RELAY X-VOLTE block and persist X-VOLTE
old_xv = '''	# X-VOLTE caller-id restore (UFI bridge: real caller in custom header)
	if (is_method("INVITE") && is_present_hf("X-VOLTE")) {
		$var(xv) = $(hdr(X-VOLTE){s.trim});
		if ($var(xv) =~ "^[0-9+]{5,20}$") {
			uac_replace_from("", "sip:" + $var(xv) + "@" + $fd);
			xlog("L_INFO", "X-VOLTE caller rewrite: From -> $var(xv) [$ci]\\n");
		}
	}'''
new_xv = '''	# Persist original numbers for CDR (before rewrites)
	if (is_method("INVITE") && !has_totag()) {
		if (strempty($dlg_var(orig_caller))) {
			$dlg_var(orig_caller) = $fU;
		}
		if (strempty($dlg_var(orig_callee))) {
			$dlg_var(orig_callee) = $tU;
		}
	}

	# X-VOLTE caller-id restore (UFI bridge: real caller in custom header)
	if (is_method("INVITE") && is_present_hf("X-VOLTE")) {
		$var(xv) = $(hdr(X-VOLTE){s.trim});
		if ($var(xv) =~ "^[0-9+]{5,20}$") {
			$dlg_var(orig_caller) = $var(xv);
			uac_replace_from("", "sip:" + $var(xv) + "@" + $fd);
			xlog("L_INFO", "X-VOLTE caller rewrite: From -> $var(xv) [$ci]\\n");
		}
	}'''
if 'Persist original numbers for CDR' not in text:
    if old_xv not in text:
        raise SystemExit('X-VOLTE block not found')
    text = text.replace(old_xv, new_xv, 1)
    print('patched X-VOLTE/orig capture')
else:
    print('X-VOLTE/orig capture already patched')

# On UFI dial restore, also store orig_callee + calltype
old_ufi = '''	# UFI_DIAL_RESTORE v2: UFI bridge protocol expects R-URI = UFI registration name
	# and the real callee in the X-VOLTE header (same as link#3 inbound format)
	if (!strempty($var(ufi_dial)) && $(ru{uri.user}) != $var(ufi_dial)) {
		append_hf("X-VOLTE: $var(ufi_dial)\\r\\n");
		xlog("L_INFO", "UFI bridge: X-VOLTE append -> $var(ufi_dial), R-URI kept $ru [$ci]\\n");
	}'''
new_ufi = '''	# UFI_DIAL_RESTORE v2: UFI bridge protocol expects R-URI = UFI registration name
	# and the real callee in the X-VOLTE header (same as link#3 inbound format)
	if (!strempty($var(ufi_dial)) && $(ru{uri.user}) != $var(ufi_dial)) {
		$dlg_var(orig_callee) = $var(ufi_dial);
		# phone/VOS -> UFI/mobile is treated as outbound from the PBX perspective
		if (strempty($avp(calltype))) {
			$avp(calltype) = "outbound";
		}
		append_hf("X-VOLTE: $var(ufi_dial)\\r\\n");
		xlog("L_INFO", "UFI bridge: X-VOLTE append -> $var(ufi_dial), R-URI kept $ru [$ci]\\n");
	}'''
if '$dlg_var(orig_callee) = $var(ufi_dial)' not in text:
    if old_ufi not in text:
        raise SystemExit('UFI_DIAL_RESTORE block not found')
    text = text.replace(old_ufi, new_ufi, 1)
    print('patched UFI_DIAL_RESTORE')
else:
    print('UFI_DIAL_RESTORE already patched')

# When carrier hits LOCATION for UFI bridge, seed orig_callee and calltype
old_loc = '''	# UFI bridge: carrier-sourced calls may reach registered endpoints via dbaliases
	if (!isbflagset(FLB_SRC_PBX)) {
		if (!isbflagset(FLB_SRC_CARRIER)) {
			return;
		}
		$var(ufi_dial) = $rU;  # UFI_DIAL_RESTORE: save original callee BEFORE alias rewrite
		$var(saved_rd) = $rd;
		$rd = "106.75.29.22";
		if (!alias_db_lookup("dbaliases")) {
			$rd = $var(saved_rd);
			return;
		}
	}'''
new_loc = '''	# UFI bridge: carrier-sourced calls may reach registered endpoints via dbaliases
	if (!isbflagset(FLB_SRC_PBX)) {
		if (!isbflagset(FLB_SRC_CARRIER)) {
			return;
		}
		$var(ufi_dial) = $rU;  # UFI_DIAL_RESTORE: save original callee BEFORE alias rewrite
		$dlg_var(orig_callee) = $rU;
		$dlg_var(orig_caller) = $fU;
		if (strempty($avp(calltype))) {
			$avp(calltype) = "outbound";
		}
		$var(saved_rd) = $rd;
		$rd = "106.75.29.22";
		if (!alias_db_lookup("dbaliases")) {
			$rd = $var(saved_rd);
			return;
		}
	} else {
		# PBX-sourced calls into LOCATION (registered endpoints)
		if (strempty($dlg_var(orig_caller))) { $dlg_var(orig_caller) = $fU; }
		if (strempty($dlg_var(orig_callee))) { $dlg_var(orig_callee) = $tU; }
		if (strempty($avp(calltype))) { $avp(calltype) = "outbound"; }
	}'''
if 'PBX-sourced calls into LOCATION' not in text:
    if old_loc not in text:
        raise SystemExit('LOCATION UFI bridge block not found')
    text = text.replace(old_loc, new_loc, 1)
    print('patched LOCATION UFI bridge')
else:
    print('LOCATION UFI bridge already patched')

cfg_path.write_text(text)
print('kamailio.cfg updated')
PY

kamailio -c -f "$CFG"
systemctl reload kamailio || systemctl restart kamailio
sleep 1
systemctl is-active kamailio
echo 'kamailio reload ok'
