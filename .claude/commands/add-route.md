Add a new flight route to the flightbot monitor based on: $ARGUMENTS

Example: `/add-route GRU to JFK round trip Sep 10 return Sep 20 budget 4000 BRL max 1 stop`

Steps:

1. Read `/Users/rafael/Dev/flightbot/config.json` to understand the current routes and schema.

2. Parse $ARGUMENTS to extract:
   - Origin IATA code (e.g. GRU)
   - Destination IATA code (e.g. JFK)
   - Trip type: round trip or one-way
   - Departure date → convert to YYYY-MM-DD
   - Return date (round trip only) → convert to YYYY-MM-DD
   - Currency (default BRL if monitoring from Brazil; ask if ambiguous)
   - maxBudget (integer; null if not mentioned)
   - maxStops (integer; null if not mentioned)
   - maxDurationHours (number; null if not mentioned)
   - flexDays (integer; 0 if not mentioned; parse from "±N days" or "flexible N")
   - Route name in format "AAA → BBB"

3. Construct the route object using this exact schema:
   ```json
   {
     "name": "GRU → JFK",
     "from": "GRU",
     "to": "JFK",
     "roundTrip": true,
     "departureDate": "2026-09-10",
     "returnDate": "2026-09-20",
     "flexDays": 0,
     "currency": "BRL",
     "maxStops": 1,
     "maxBudget": 4000,
     "maxDurationHours": null,
     "active": true
   }
   ```
   If any required field is ambiguous (origin, destination, departure date), ask the user before proceeding.

4. Show the constructed JSON and ask for confirmation before writing to disk.

5. After confirmation, append the route to the `routes` array in `config.json` and write the file. Print the updated routes list.

6. Remind the user: `config.json` is not synced by `/deploy` (to protect live state). To push this new route to EC2, run:
   ```
   rsync -avz -e 'ssh -o StrictHostKeyChecking=no -i "/Users/rafael/Desktop/Documentos/poc-dev-key.pem"' /Users/rafael/Dev/flightbot/config.json ec2-user@ec2-54-91-170-193.compute-1.amazonaws.com:/home/ec2-user/flightbot/config.json
   ```
   Then restart the container so the bot picks up the new config:
   ```
   ssh -i "/Users/rafael/Desktop/Documentos/poc-dev-key.pem" -o StrictHostKeyChecking=no ec2-user@ec2-54-91-170-193.compute-1.amazonaws.com "cd /home/ec2-user/flightbot && docker-compose restart"
   ```
