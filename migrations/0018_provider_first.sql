-- Generic provider mode: imported provider services are the active catalogue.
UPDATE settings SET value = '0' WHERE key = 'sync_enabled';
UPDATE services SET enabled = 0 WHERE provider_id = 0;
