-- Idempotent multi-tenant backfill. Application startup also runs this via acl.backfill_tenants.
-- Default tenant is keyed by code='default', not by id=1.

INSERT IGNORE INTO dsip_customer (name, code, note, enabled, created)
VALUES ('默认租户', 'default', '存量数据归属', 1, NOW());

-- Columns are added by acl.ensure_acl_tables. After that:
-- UPDATE dsip_ufi_device SET customer_id=(SELECT id FROM dsip_customer WHERE code='default') WHERE customer_id IS NULL;
-- Repeat for dsip_ufi_pool, dsip_ufi_pool_cfg, dsip_ufi_pool_did, dr_gw_lists, dr_rules, dsip_cdrinfo, dsip_ip_whitelist.
