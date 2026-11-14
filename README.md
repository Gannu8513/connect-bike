# Connect Bike

A free web app for looking after a Honda CB350RS. It runs in the browser and can be installed on an iPhone from Safari (Share, then Add to Home Screen).

- Ride tracking with a speedometer, auto-pause at stops, lean angle and G-force from the phone's sensors, ride replay and GPX export
- Navigation: place search, tap-the-map destinations, spoken turns, nearby fuel and workshops
- Parking: where the bike is now, how long it has been there, and where it was kept before
- Fuel log with mileage, cost per km and range
- Garage: maintenance reminders, tyre, battery and brake-pad wear, service history with photos of bills
- Money: expenses, monthly budget with warnings
- Trips, odometer history, documents with expiry alerts, pre-ride checklist, emergency card, stats
- PDF service report, backup files, optional cloud sync through a private GitHub gist, light and dark themes

Data stays on the phone. Speed, distance and position come from the phone's GPS, and lean and G-force from its motion sensors; nothing is read from the motorcycle.

No build step: serve the folder with any static web server, for example `python -m http.server`.
