# Migrations

Migrations 002+ belong to this service and are additive only.

The target database (`mydb`) is shared and already populated — `products`,
`users`, and `user_password` exist with live data, and its `schema_migrations`
table records `001_create_users.sql`, applied by another project on 2026-09-27.

This service therefore **reads the schema as it is and does not modify it**.
`scripts/migrate.js` is kept for future use; `npm run migrate:status` lists
migrations applied by other projects under `external`.

If you do add a migration here:

- name it `NNN_description.sql`, numbered after the highest existing one;
- make it additive — never drop or rewrite a column another project depends on;
- never edit a file once applied (the runner checksums them and will refuse).
