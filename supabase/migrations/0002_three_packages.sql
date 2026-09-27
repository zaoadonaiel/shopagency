-- The shop sells three packages: Avada Setup (one-time), Hosting and Zao Chat & Zao Flo (monthly).
-- billing_interval is null for a one-time price, 'month' for a monthly one. It only changes how the
-- price and button read in the shop; checkout still charges price_cents once.
alter table public.packages add column billing_interval text check (billing_interval in ('month'));

-- Old packages are switched off, not deleted: past orders still point at them.
update public.packages set active = false;

insert into public.packages (name, description, price_cents, contractor_pct, billing_interval) values
  ('Avada Setup', 'Avada installed on our hosting, your template applied, and 5 pages built from your intake form. You can resell this for whatever price makes sense for your market. In the course, you''ll learn how to build these out, customize them, and charge accordingly.', 5000, 40, null),
  ('Hosting', 'Fully managed by our team. $25/month wholesale. You can charge your clients $40 to $60/month and keep $15 to $35/month MRR. This is the recurring revenue engine of the agency model. In the course, you''ll learn how to position this and close deals with it.', 2500, 40, 'month'),
  ('Zao Chat & Zao Flo', 'AI lead-gen chatbot and AI blog automation. $50/month wholesale. You can charge your clients $299/month and keep $249/month MRR. Perfect for AEO and SEO. Zao Chat captures leads directly and emails them to your clients so they never miss a potential customer.', 5000, 40, 'month');
