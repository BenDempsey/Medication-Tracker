FROM python:3.11-slim

RUN useradd -m -u 1000 medapp && \
    mkdir -p /app /data && \
    chown -R medapp:medapp /app /data

WORKDIR /app
USER medapp

COPY --chown=medapp:medapp requirements.txt .
RUN pip install --no-cache-dir --user -r requirements.txt

COPY --chown=medapp:medapp app.py .
COPY --chown=medapp:medapp templates/ templates/
COPY --chown=medapp:medapp static/ static/

ENV PATH="/home/medapp/.local/bin:$PATH"
ENV FLASK_ENV=production
ENV DB_NAME=/data/medications.db

EXPOSE 7007

CMD ["python", "app.py"]
