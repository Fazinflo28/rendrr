# One-off copier: Railway Postgres (version 18) -> Supabase (see copy.sh). pg_dump must be at least the source's
# version; pg_restore 18 writes into older servers (15-17) too, skipping the few settings they do not know.
FROM postgres:18-alpine
COPY copy.sh /copy.sh
RUN chmod +x /copy.sh
CMD ["/copy.sh"]
