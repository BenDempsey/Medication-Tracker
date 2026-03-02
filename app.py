from flask import Flask, render_template, request, jsonify
import sqlite3
import requests
from contextlib import contextmanager
import os
from flask_apscheduler import APScheduler  # periodic jobs

# -----------------------------------------------------------------------------
# App & config
# -----------------------------------------------------------------------------
app = Flask(__name__)
app.config['SECRET_KEY'] = os.urandom(24)

DB_NAME = os.getenv('DB_NAME', 'medications.db')
NTFY_SERVER = os.getenv('NTFY_SERVER', 'https://ntfy.sh')
NTFY_TOPIC = os.getenv('NTFY_TOPIC', 'medication_alerts')
PORT = int(os.getenv('PORT', '7010'))

scheduler = APScheduler()


# -----------------------------------------------------------------------------
# DB helpers
# -----------------------------------------------------------------------------
@contextmanager
def get_db():
    conn = sqlite3.connect(DB_NAME)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


def init_db():
    with get_db() as conn:
        conn.executescript('''
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS medications (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                barcode TEXT,
                daily_dose INTEGER DEFAULT 1,
                time_of_day TEXT DEFAULT "08:00",
                current_qty INTEGER DEFAULT 0,
                alert_threshold INTEGER DEFAULT 7,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS prescriptions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                med_id INTEGER NOT NULL,
                total_repeats INTEGER DEFAULT 0,
                repeats_left INTEGER DEFAULT 0,
                expiry_date DATE,
                barcode TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(med_id) REFERENCES medications(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS usage_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                med_id INTEGER NOT NULL,
                qty_used INTEGER DEFAULT 1,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(med_id) REFERENCES medications(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS dose_times (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                med_id INTEGER NOT NULL,
                time_of_day TEXT NOT NULL,
                amount INTEGER DEFAULT 1,
                label TEXT,
                FOREIGN KEY(med_id) REFERENCES medications(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_usage_med_id ON usage_log(med_id);
        ''')
        conn.commit()


# -----------------------------------------------------------------------------
# ntfy notifications
# -----------------------------------------------------------------------------
def send_ntfy(message, priority="default", tags=None):
    try:
        headers = {"Title": "Medication Alert"}
        if tags:
            headers["Tags"] = tags
        if priority:
            headers["Priority"] = priority

        requests.post(
            f"{NTFY_SERVER.rstrip('/')}/{NTFY_TOPIC}",
            data=message.encode('utf-8'),
            headers=headers,
            timeout=5
        )
    except Exception as e:
        # Fail closed on notifications; do not crash app
        print(f"ntfy error: {e}")


def check_alerts():
    """Check low stock and script expiry and send ntfy alerts."""
    with get_db() as conn:
        # Low stock
        low_meds = conn.execute('''
            SELECT name, current_qty, alert_threshold
            FROM medications
            WHERE current_qty <= alert_threshold AND current_qty > 0
        ''').fetchall()

        for med in low_meds:
            send_ntfy(
                f"⚠ {med['name']} is low: {med['current_qty']} remaining",
                priority="high",
                tags="warning"
            )

        # Out of stock
        out_meds = conn.execute('''
            SELECT name FROM medications WHERE current_qty <= 0
        ''').fetchall()

        for med in out_meds:
            send_ntfy(
                f"🚨 {med['name']} is OUT OF STOCK",
                priority="urgent",
                tags="rotating_light"
            )

        # Scripts expiring within 30 days
        expiring = conn.execute('''
            SELECT m.name, p.expiry_date, p.repeats_left
            FROM prescriptions p
            JOIN medications m ON p.med_id = m.id
            WHERE DATE(p.expiry_date) <= DATE('now', '+30 days')
              AND DATE(p.expiry_date) >= DATE('now')
        ''').fetchall()

        for script in expiring:
            send_ntfy(
                f"📋 {script['name']} script expires: {script['expiry_date']} "
                f"({script['repeats_left']} repeats left)",
                priority="high",
                tags="pill"
            )


# -----------------------------------------------------------------------------
# Routes
# -----------------------------------------------------------------------------
@app.route('/')
def index():
    # Ensure alerts always up to date when user opens/refreshed the app
    check_alerts()
    return render_template('index.html')


@app.route('/health')
def health():
    return "ok", 200


@app.route('/api/medications', methods=['GET'])
def get_medications():
    with get_db() as conn:
        meds = conn.execute('''
            SELECT m.*,
                   COALESCE(p.repeats_left, 0) AS repeats_left,
                   p.expiry_date
            FROM medications m
            LEFT JOIN prescriptions p ON m.id = p.med_id
            ORDER BY m.name
        ''').fetchall()
        return jsonify([dict(med) for med in meds])


@app.route('/api/medications', methods=['POST'])
def add_medication():
    data = request.get_json() or {}
    name = data.get('name')
    if not name or not isinstance(name, str):
        return jsonify({"error": "Name required"}), 400

    with get_db() as conn:
        cursor = conn.execute('''
            INSERT INTO medications
            (name, barcode, daily_dose, time_of_day, current_qty, alert_threshold)
            VALUES (?, ?, ?, ?, ?, ?)
        ''', (
            name.strip(),
            (data.get('barcode') or '').strip() or None,
            int(data.get('daily_dose') or 1),
            data.get('time_of_day') or '08:00',
            int(data.get('current_qty') or 0),
            int(data.get('alert_threshold') or 7),
        ))
        conn.commit()
        return jsonify({"id": cursor.lastrowid, "message": "Medication added"}), 201


@app.route('/api/prescriptions', methods=['POST'])
def add_prescription():
    data = request.get_json() or {}
    med_id = data.get('med_id')
    if not med_id:
        return jsonify({"error": "med_id required"}), 400

    with get_db() as conn:
        cursor = conn.execute('''
            INSERT INTO prescriptions
            (med_id, total_repeats, repeats_left, expiry_date, barcode)
            VALUES (?, ?, ?, ?, ?)
        ''', (
            int(med_id),
            int(data.get('total_repeats') or 0),
            int(data.get('total_repeats') or 0),
            data.get('expiry_date'),
            (data.get('barcode') or '').strip() or None,
        ))
        conn.commit()
        return jsonify({"id": cursor.lastrowid, "message": "Prescription added"}), 201


@app.route('/api/medications/<int:med_id>/use', methods=['POST'])
def log_usage(med_id):
    data = request.get_json() or {}
    qty = int(data.get('qty_used') or 1)
    if qty <= 0:
        return jsonify({"error": "qty_used must be > 0"}), 400

    with get_db() as conn:
        conn.execute(
            'INSERT INTO usage_log (med_id, qty_used) VALUES (?, ?)',
            (med_id, qty)
        )
        conn.execute('''
            UPDATE medications
            SET current_qty = current_qty - ?
            WHERE id = ?
        ''', (qty, med_id))
        conn.commit()

    check_alerts()
    return jsonify({"message": "Usage logged"}), 200


@app.route('/api/medications/<int:med_id>/adjust', methods=['PATCH'])
def adjust_medication(med_id):
    data = request.get_json() or {}
    if not data:
        return jsonify({"error": "No fields to update"}), 400

    fields = []
    values = []

    if 'daily_dose' in data:
        fields.append('daily_dose = ?')
        values.append(int(data['daily_dose']))

    # Prefer relative adjust_by if provided
    if 'adjust_by' in data:
        fields.append('current_qty = current_qty + ?')
        values.append(int(data['adjust_by']))
    elif 'current_qty' in data:
        fields.append('current_qty = ?')
        values.append(int(data['current_qty']))

    if 'time_of_day' in data:
        fields.append('time_of_day = ?')
        values.append(data['time_of_day'])

    if not fields:
        return jsonify({"error": "No valid fields"}), 400

    values.append(med_id)

    with get_db() as conn:
        conn.execute(f'''
            UPDATE medications
            SET {', '.join(fields)}
            WHERE id = ?
        ''', values)
        conn.commit()

    check_alerts()
    return jsonify({"message": "Medication updated"}), 200


@app.route('/api/check-alerts', methods=['POST'])
def trigger_alerts():
    check_alerts()
    return jsonify({"message": "Alerts checked"}), 200


@app.route('/api/medications/<int:med_id>/doses', methods=['GET'])
def get_doses(med_id):
    with get_db() as conn:
        rows = conn.execute('''
            SELECT id, time_of_day, amount, COALESCE(label, '') AS label
            FROM dose_times
            WHERE med_id = ?
            ORDER BY time_of_day
        ''', (med_id,)).fetchall()
        return jsonify([dict(r) for r in rows])


@app.route('/api/medications/<int:med_id>/doses', methods=['POST'])
def add_dose(med_id):
    data = request.get_json() or {}
    time_of_day = data.get('time_of_day')
    amount = int(data.get('amount') or 1)
    label = (data.get('label') or '').strip() or None

    if not time_of_day:
        return jsonify({"error": "time_of_day required"}), 400

    with get_db() as conn:
        cur = conn.execute('''
            INSERT INTO dose_times (med_id, time_of_day, amount, label)
            VALUES (?, ?, ?, ?)
        ''', (med_id, time_of_day, amount, label))
        conn.commit()
        return jsonify({"id": cur.lastrowid}), 201


@app.route('/api/doses/<int:dose_id>', methods=['DELETE'])
def delete_dose(dose_id):
    with get_db() as conn:
        conn.execute('DELETE FROM dose_times WHERE id = ?', (dose_id,))
        conn.commit()
        return jsonify({"message": "Dose deleted"}), 200


@app.route('/api/medications/<int:med_id>', methods=['DELETE'])
def delete_medication(med_id):
    with get_db() as conn:
        cur = conn.execute('DELETE FROM medications WHERE id = ?', (med_id,))
        conn.commit()
        if cur.rowcount == 0:
            return jsonify({"error": "Medication not found"}), 404
    check_alerts()
    return jsonify({"message": "Medication deleted"}), 200


# -----------------------------------------------------------------------------
# Scheduler job
# -----------------------------------------------------------------------------
@scheduler.task('interval', id='medication_alert_job', minutes=10)
def scheduled_check():
    with app.app_context():
        check_alerts()


# -----------------------------------------------------------------------------
# Entry point
# -----------------------------------------------------------------------------
if __name__ == '__main__':
    init_db()
    scheduler.init_app(app)
    scheduler.start()
    app.run(host='0.0.0.0', port=PORT, debug=False)
