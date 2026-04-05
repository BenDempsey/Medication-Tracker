from flask import Flask, render_template, request, jsonify
import sqlite3
from contextlib import contextmanager
import os
from flask_apscheduler import APScheduler
from datetime import datetime, timedelta

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
    conn.execute('PRAGMA foreign_keys = ON')
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
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_deducted_at DATETIME
            );

            CREATE TABLE IF NOT EXISTS prescriptions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                med_id INTEGER NOT NULL,
                total_repeats INTEGER DEFAULT 0,
                repeats_left INTEGER DEFAULT 0,
                expiry_date DATE,
                barcode TEXT,
                units_per_fill INTEGER DEFAULT 0,
                fills_used INTEGER DEFAULT 0,
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
            CREATE UNIQUE INDEX IF NOT EXISTS idx_med_name ON medications(name);
        ''')
        # Safely add column to existing DBs without wiping data
        try:
            conn.execute('ALTER TABLE prescriptions ADD COLUMN units_per_fill INTEGER DEFAULT 0')
        except sqlite3.OperationalError:
            pass
        try:
            conn.execute('ALTER TABLE prescriptions ADD COLUMN fills_used INTEGER DEFAULT 0')
        except sqlite3.OperationalError:
            pass
        try:
            conn.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_med_name ON medications(name)')
        except sqlite3.OperationalError:
            pass
        conn.commit()


# -----------------------------------------------------------------------------
# Alerts (ntfy stubbed, UI shows alerts)
# -----------------------------------------------------------------------------
# def send_ntfy(message, priority="default", tags=None):
#     try:
#         headers = {"Title": "Medication Alert"}
#         if tags:
#             headers["Tags"] = tags
#         if priority:
#             headers["Priority"] = priority
#         requests.post(
#             f"{NTFY_SERVER.rstrip('/')}/{NTFY_TOPIC}",
#             data=message.encode('utf-8'),
#             headers=headers,
#             timeout=5
#         )
#     except Exception as e:
#         print(f"ntfy error: {e}")


def check_alerts():
    alerts = []
    with get_db() as conn:
        # Low stock but not zero
        low_meds = conn.execute('''
            SELECT name, current_qty, alert_threshold
            FROM medications
            WHERE current_qty <= alert_threshold AND current_qty > 0
        ''').fetchall()
        for med in low_meds:
            alerts.append({
                "type": "low",
                "text": f"{med['name']} is low: {med['current_qty']} remaining"
            })

        # Out of stock
        out_meds = conn.execute(
            'SELECT name FROM medications WHERE current_qty <= 0'
        ).fetchall()
        for med in out_meds:
            alerts.append({
                "type": "out",
                "text": f"{med['name']} is OUT OF STOCK"
            })

        # Scripts expiring in <= 2 days (today + next 2 days)
        expiring = conn.execute('''
            SELECT m.name, p.expiry_date, p.repeats_left
            FROM prescriptions p
            JOIN medications m ON p.med_id = m.id
            WHERE DATE(p.expiry_date) <= DATE('now', '+2 days')
              AND DATE(p.expiry_date) >= DATE('now')
        ''').fetchall()
        for script in expiring:
            alerts.append({
                "type": "script_expiry",
                "text": (
                    f"{script['name']} script expires on {script['expiry_date']} "
                    f"({script['repeats_left']} repeats left)"
                )
            })

        # Scripts with very low repeats (1 left)
        low_repeats = conn.execute('''
            SELECT m.name, p.repeats_left, p.expiry_date
            FROM prescriptions p
            JOIN medications m ON p.med_id = m.id
            WHERE p.repeats_left = 1
        ''').fetchall()
        for script in low_repeats:
            alerts.append({
                "type": "script_repeats",
                "text": (
                    f"{script['name']} script has 1 repeat left"
                    f"{' (expires ' + script['expiry_date'] + ')' if script['expiry_date'] else ''}"
                )
            })

    # Still log to console for now
    for a in alerts:
        print(f"[ALERT] {a['text']}")

    return alerts


# -----------------------------------------------------------------------------
# Automatic dose deduction (supports fake-now testing)
# -----------------------------------------------------------------------------
def deduct_missed_doses(now_override=None):
    """Walk every medication's dose schedule and deduct missed doses."""
    now = now_override or datetime.now()
    with get_db() as conn:
        meds = conn.execute('SELECT * FROM medications').fetchall()

        for med in meds:
            med_id = med['id']
            last = med['last_deducted_at']

            if not last:
                # First run: set baseline, skip retroactive deduction
                conn.execute(
                    'UPDATE medications SET last_deducted_at = ? WHERE id = ?',
                    (now.isoformat(), med_id)
                )
                continue

            since = datetime.fromisoformat(last)

            # Use dose_times rows if any, else fall back to daily_dose + time_of_day
            dose_rows = conn.execute(
                'SELECT time_of_day, amount FROM dose_times WHERE med_id = ?',
                (med_id,)
            ).fetchall()

            doses = (
                [(r['time_of_day'], r['amount']) for r in dose_rows]
                if dose_rows
                else [(med['time_of_day'], med['daily_dose'])]
            )

            total_deduct = 0
            check_date = since.date()
            while check_date <= now.date():
                for time_str, amount in doses:
                    try:
                        h, m = map(int, time_str.split(':'))
                    except (ValueError, AttributeError):
                        continue
                    dose_dt = datetime.combine(
                        check_date,
                        datetime.min.time().replace(hour=h, minute=m)
                    )
                    if since < dose_dt <= now:
                        total_deduct += amount
                check_date += timedelta(days=1)

            if total_deduct > 0:
                conn.execute('''
                    UPDATE medications
                    SET current_qty = MAX(0, current_qty - ?),
                        last_deducted_at = ?
                    WHERE id = ?
                ''', (total_deduct, now.isoformat(), med_id))
                conn.execute(
                    'INSERT INTO usage_log (med_id, qty_used) VALUES (?, ?)',
                    (med_id, total_deduct)
                )
            else:
                conn.execute(
                    'UPDATE medications SET last_deducted_at = ? WHERE id = ?',
                    (now.isoformat(), med_id)
                )

        conn.commit()

    check_alerts()


# -----------------------------------------------------------------------------
# Routes
# -----------------------------------------------------------------------------

@app.route('/api/prescriptions/<int:script_id>/fill', methods=['POST'])
def fill_prescription(script_id):
    with get_db() as conn:
        script = conn.execute('''
            SELECT p.med_id, p.repeats_left, p.units_per_fill, p.fills_used
            FROM prescriptions p
            WHERE p.id = ?
        ''', (script_id,)).fetchone()
        if not script:
            return jsonify({"error": "Prescription not found"}), 404

        if script['repeats_left'] <= 0:
            return jsonify({"error": "No repeats left"}), 400

        units = script['units_per_fill'] or 0
        if units <= 0:
            return jsonify({"error": "units_per_fill not set"}), 400

        conn.execute('''
            UPDATE medications
            SET current_qty = current_qty + ?
            WHERE id = ?
        ''', (units, script['med_id']))

        conn.execute('''
            UPDATE prescriptions
            SET repeats_left = repeats_left - 1,
                fills_used = fills_used + 1
            WHERE id = ?
        ''', (script_id,))

        conn.commit()

    check_alerts()
    return jsonify({"message": "Script filled", "added": units}), 200


@app.route('/api/prescriptions', methods=['GET'])
def list_prescriptions():
    med_id = request.args.get('med_id', type=int)
    with get_db() as conn:
        if med_id:
            rows = conn.execute('''
                SELECT p.id, p.med_id, m.name,
                       p.total_repeats, p.repeats_left,
                       p.units_per_fill, p.fills_used,
                       p.expiry_date, p.barcode
                FROM prescriptions p
                JOIN medications m ON p.med_id = m.id
                WHERE p.med_id = ?
                ORDER BY m.name, p.expiry_date
            ''', (med_id,)).fetchall()
        else:
            rows = conn.execute('''
                SELECT p.id, p.med_id, m.name,
                       p.total_repeats, p.repeats_left,
                       p.units_per_fill, p.fills_used,
                       p.expiry_date, p.barcode
                FROM prescriptions p
                JOIN medications m ON p.med_id = m.id
                ORDER BY m.name, p.expiry_date
            ''').fetchall()
    return jsonify([dict(r) for r in rows])


@app.route('/')
def index():
    # Keep these so the dashboard is always up to date on load
    deduct_missed_doses()
    check_alerts()
    return render_template('index.html')


@app.route('/health')
def health():
    return "ok", 200


@app.route('/api/medications', methods=['GET'])
def get_medications():
    with get_db() as conn:
        rows = conn.execute('''
            SELECT
                m.id            AS med_id,
                m.name          AS name,
                m.barcode       AS med_barcode,
                m.daily_dose    AS daily_dose,
                m.time_of_day   AS time_of_day,
                m.current_qty   AS current_qty,
                m.alert_threshold AS alert_threshold,
                p.id            AS script_id,
                p.total_repeats AS total_repeats,
                COALESCE(p.repeats_left, 0) AS repeats_left,
                p.expiry_date   AS expiry_date,
                p.barcode       AS script_barcode,
                p.units_per_fill AS units_per_fill
            FROM medications m
            LEFT JOIN prescriptions p ON m.id = p.med_id
            ORDER BY m.name, p.expiry_date
        ''').fetchall()

        raw = request.args.get('raw', '0') == '1'
        result = []
        for row in rows:
            r = dict(row)
            if not raw:
                # Append x{units_per_fill} to display name if not already present
                units = r.get('units_per_fill')
                base  = r['name']
                suffix = f" x{units}" if units else ''
                if suffix and not base.endswith(suffix):
                    r['name'] = base + suffix
            result.append(r)

    return jsonify(result)


@app.route('/api/medications', methods=['POST'])
def add_medication():
    data = request.get_json() or {}
    name = data.get('name')
    if not name or not isinstance(name, str):
        return jsonify({"error": "Name required"}), 400

    with get_db() as conn:
        try:
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
        except sqlite3.IntegrityError:
            return jsonify({"error": "Medication already exists"}), 409


@app.route('/api/prescriptions', methods=['POST'])
def add_prescription():
    data = request.get_json() or {}
    med_id = data.get('med_id')
    if not med_id:
        return jsonify({"error": "med_id required"}), 400

    try:
        total_repeats  = int(data.get('total_repeats')  or 0)
        units_per_fill = int(data.get('units_per_fill') or 0)
    except (TypeError, ValueError):
        return jsonify({"error": "bad numbers"}), 400

    with get_db() as conn:
        # Look up the base medication name
        med = conn.execute(
            'SELECT id, name FROM medications WHERE id = ?', (int(med_id),)
        ).fetchone()
        if not med:
            return jsonify({"error": "Medication not found"}), 404

        base_name = med['name']

        # Resolve which medication row to attach this prescription to.
        # Rule: same name + same units_per_fill → same med row (merge repeats).
        #       same name + different units_per_fill → separate med row named
        #       "{base_name} x{units_per_fill}" (created if it doesn't exist).
        target_med_id = int(med_id)

        if units_per_fill > 0:
            # Does this med already have a prescription with a DIFFERENT units_per_fill?
            other_units = conn.execute('''
                SELECT DISTINCT units_per_fill
                FROM prescriptions
                WHERE med_id = ? AND units_per_fill != ?
            ''', (target_med_id, units_per_fill)).fetchone()

            if other_units:
                # Need a separate medication row for this units_per_fill value
                variant_name = f"{base_name} x{units_per_fill}"
                existing = conn.execute(
                    'SELECT id FROM medications WHERE name = ?', (variant_name,)
                ).fetchone()
                if existing:
                    target_med_id = existing['id']
                else:
                    # Clone the parent med's settings into the new variant row
                    parent = conn.execute(
                        'SELECT daily_dose, time_of_day, alert_threshold FROM medications WHERE id = ?',
                        (int(med_id),)
                    ).fetchone()
                    cur = conn.execute('''
                        INSERT INTO medications
                          (name, daily_dose, time_of_day, current_qty, alert_threshold)
                        VALUES (?, ?, ?, 0, ?)
                    ''', (
                        variant_name,
                        parent['daily_dose'],
                        parent['time_of_day'],
                        parent['alert_threshold'],
                    ))
                    target_med_id = cur.lastrowid

        # Check for existing prescription on the resolved med with the same units_per_fill
        existing_script = conn.execute('''
            SELECT id, repeats_left, total_repeats
            FROM prescriptions
            WHERE med_id = ? AND units_per_fill = ?
            ORDER BY created_at DESC
            LIMIT 1
        ''', (target_med_id, units_per_fill)).fetchone()

        if existing_script:
            # Merge — add repeats to the existing prescription
            conn.execute('''
                UPDATE prescriptions
                SET repeats_left   = repeats_left + ?,
                    total_repeats  = total_repeats + ?
                WHERE id = ?
            ''', (total_repeats, total_repeats, existing_script['id']))
            conn.commit()
            return jsonify({
                "id":      existing_script['id'],
                "message": "Repeats added to existing prescription",
                "merged":  True
            }), 200
        else:
            cursor = conn.execute('''
                INSERT INTO prescriptions
                  (med_id, total_repeats, repeats_left,
                   expiry_date, barcode, units_per_fill, fills_used)
                VALUES (?, ?, ?, ?, ?, ?, 0)
            ''', (
                target_med_id,
                total_repeats,
                total_repeats,
                data.get('expiry_date'),
                (data.get('barcode') or '').strip() or None,
                units_per_fill,
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
        # ensure med exists
        med = conn.execute(
            'SELECT current_qty FROM medications WHERE id = ?',
            (med_id,)
        ).fetchone()
        if not med:
            return jsonify({"error": "Medication not found"}), 404

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

    if 'alert_threshold' in data:
        fields.append('alert_threshold = ?')
        values.append(int(data['alert_threshold']))

    if 'adjust_by' in data:
        fields.append('current_qty = current_qty + ?')
        values.append(int(data['adjust_by']))
    elif 'current_qty' in data:
        fields.append('current_qty = ?')
        values.append(int(data['current_qty']))

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
    alerts = check_alerts()
    return jsonify({"alerts": alerts}), 200


# -----------------------------------------------------------------------------
# Test deduction endpoints (TEMP: safe to remove later)
# -----------------------------------------------------------------------------
@app.route('/api/test-deduction', methods=['POST'])
def test_deduction():
    deduct_missed_doses()
    return jsonify({"message": "Deduction run"}), 200


@app.route('/api/test-deduction-at', methods=['POST'])
def test_deduction_at():
    data = request.get_json() or {}
    fake_now = data.get('now')
    if not fake_now:
        return jsonify({"error": "now required (ISO string)"}), 400

    try:
        dt = datetime.fromisoformat(fake_now)
    except ValueError:
        return jsonify({"error": "invalid datetime"}), 400

    deduct_missed_doses(now_override=dt)
    return jsonify({"message": f"Deduction run at {fake_now}"}), 200


# -----------------------------------------------------------------------------
# Dose time routes
# -----------------------------------------------------------------------------
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
# Scheduler — runs deduction + alerts every 10 min
# -----------------------------------------------------------------------------
@scheduler.task('interval', id='medication_alert_job', minutes=10)
def scheduled_check():
    with app.app_context():
        deduct_missed_doses()


# -----------------------------------------------------------------------------
# Entry point
# -----------------------------------------------------------------------------
if __name__ == '__main__':
    init_db()
    scheduler.init_app(app)
    scheduler.start()
    app.run(host='0.0.0.0', port=PORT, debug=False)
