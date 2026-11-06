# One-off copier: Railway Postgres -> Supabase (see copy.sh). PostgreSQL 17 client tools read and write 15-17 servers.
FROM postgres:17-alpine
COPY copy.sh /copy.sh
RUN chmod +x /copy.sh
CMD ["/copy.sh"]
