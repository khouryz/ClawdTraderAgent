#!/usr/bin/env python3
"""Front-month contract for a CME quarterly future (H/M/U/Z cycle).

Expiry is the THIRD FRIDAY of the contract month. We roll ROLL_DAYS before that,
so the front month becomes the next quarter once the current one is inside the
roll window — matching the "roll before Thu 10 Sep for an 18 Sep expiry" rule.
"""
import sys, datetime

CODES = {3: 'H', 6: 'M', 9: 'U', 12: 'Z'}
ROLL_DAYS = 8


def third_friday(y, m):
    d = datetime.date(y, m, 1)
    fridays = [d.replace(day=x) for x in range(1, 32)
               if x <= (datetime.date(y + (m == 12), (m % 12) + 1, 1) - datetime.timedelta(days=1)).day
               and d.replace(day=x).weekday() == 4]
    return fridays[2]


def front(prefix, today=None):
    today = today or datetime.date.today()
    for step in range(0, 8):
        m = ((today.month - 1 + step) // 3) * 3 + 3
        y = today.year + (m - 1) // 12
        m = ((m - 1) % 12) + 1
        if m not in CODES:
            continue
        exp = third_friday(y, m)
        if (exp - today).days > ROLL_DAYS:
            return f"{prefix}{CODES[m]}{y % 10}", exp, (exp - today).days
    raise SystemExit("could not resolve a front contract")


if __name__ == '__main__':
    prefix = sys.argv[1] if len(sys.argv) > 1 else 'MNQ'
    when = datetime.date.fromisoformat(sys.argv[2]) if len(sys.argv) > 2 else None
    sym, exp, days = front(prefix, when)
    print(f"{sym} {exp.isoformat()} {days}")
