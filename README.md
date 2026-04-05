Hi all,

I made this app to run locally on your machine on port 7010. Change in app.py if required.
Note this is just for personal use only, I need to add encryption, authentication and more security overall for a real deployement.
Perhaps I will also add to a docker container for better usablity, more on that later.
It's designed to be able to enter medications, prescriptions, fill presriptions, adjust daily use and alert when low.
I hope you can get good use of this and I plan to upgrade later.

To get started install the requirements in requirements.txt in a bash or WSL terminal.

Then run in a virtual environment, instructions are below.


# Medication Tracker

Simple Flask medication tracker app.

## Requirements

- Python 3
- Local virtual environment (`venv`)

## Local setup

in a bash terminal

python3 -m venv venv
source venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt


## Run locally

Run the app in the virtual environment on port 7010:
python3 app.py


Open in any browser:
http://127.0.0.1:7010


- Keep the app inside a local virtual environment.
- Do not commit local databases, `.env` files, or virtual environment folders.
