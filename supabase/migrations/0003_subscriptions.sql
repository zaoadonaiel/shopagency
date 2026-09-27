-- Monthly packages are billed as Stripe subscriptions. The order keeps the subscription id so a
-- refund can also stop the monthly charge.
alter table public.orders add column stripe_subscription_id text;

-- Only website builds need the buyer's Avada license code. Hosting and Zao Chat & Zao Flo do not.
alter table public.packages add column needs_avada_code boolean not null default true;
update public.packages set needs_avada_code = false where billing_interval is not null;
