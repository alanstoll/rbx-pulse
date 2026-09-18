-- Runs once, when the Postgres data volume is first created.
-- pulse       your real game (DATABASE_URL)
-- pulse_demo  the turn-key demo (`pulse demo seed`); never shares tables with pulse
-- pulse_test  wiped by the integration tests
CREATE DATABASE pulse_demo;
CREATE DATABASE pulse_test;
