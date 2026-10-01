-- Forwarder devices belong to an SMS channel and report a model. Own table (004).
ALTER TABLE forwarder_devices
  ADD COLUMN channel_id integer REFERENCES channels (id) ON DELETE SET NULL,
  ADD COLUMN model      text;
