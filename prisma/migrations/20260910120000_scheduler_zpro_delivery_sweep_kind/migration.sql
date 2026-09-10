-- The Z-PRO equivalent of DELIVERY_SWEEP (issue #228, ported to Z-PRO): finds Z-PRO webhook
-- deliveries stranded by a process death (stuck PENDING/PROCESSING past a staleness window) and
-- reports them, mirroring src/modules/chatwoot/delivery-sweep.ts's shape at a much simpler ledger
-- (ZproWebhookDelivery carries none of ChatwootWebhookDelivery's correlation columns, so this is
-- visibility only — no recovery is armed, there is nothing to re-derive live from).
--
-- Alone in its own migration because Postgres refuses to use a value added to an enum inside the
-- same transaction that added it, and Prisma runs one migration file per transaction.
ALTER TYPE "SchedulerJobKind" ADD VALUE 'ZPRO_DELIVERY_SWEEP';
