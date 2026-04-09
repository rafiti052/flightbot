Deploy the latest flightbot code to EC2 and restart the container. Execute these steps in order:

1. Rsync source files to EC2. Run each rsync separately:
   ```
   rsync -avz -e 'ssh -o StrictHostKeyChecking=no -i "/Users/rafael/Desktop/Documentos/poc-dev-key.pem"' /Users/rafael/Dev/flightbot/bot.js ec2-user@ec2-54-91-170-193.compute-1.amazonaws.com:/home/ec2-user/flightbot/
   rsync -avz -e 'ssh -o StrictHostKeyChecking=no -i "/Users/rafael/Desktop/Documentos/poc-dev-key.pem"' /Users/rafael/Dev/flightbot/Dockerfile ec2-user@ec2-54-91-170-193.compute-1.amazonaws.com:/home/ec2-user/flightbot/
   rsync -avz -e 'ssh -o StrictHostKeyChecking=no -i "/Users/rafael/Desktop/Documentos/poc-dev-key.pem"' /Users/rafael/Dev/flightbot/docker-compose.yml ec2-user@ec2-54-91-170-193.compute-1.amazonaws.com:/home/ec2-user/flightbot/
   rsync -avz -e 'ssh -o StrictHostKeyChecking=no -i "/Users/rafael/Desktop/Documentos/poc-dev-key.pem"' /Users/rafael/Dev/flightbot/package.json ec2-user@ec2-54-91-170-193.compute-1.amazonaws.com:/home/ec2-user/flightbot/
   rsync -avz -e 'ssh -o StrictHostKeyChecking=no -i "/Users/rafael/Desktop/Documentos/poc-dev-key.pem"' /Users/rafael/Dev/flightbot/package-lock.json ec2-user@ec2-54-91-170-193.compute-1.amazonaws.com:/home/ec2-user/flightbot/
   ```
   IMPORTANT: Do NOT sync config.json or prices.json — those files live on the server and must never be overwritten by a deploy.

2. Rebuild and restart the container on EC2:
   ```
   ssh -i "/Users/rafael/Desktop/Documentos/poc-dev-key.pem" -o StrictHostKeyChecking=no ec2-user@ec2-54-91-170-193.compute-1.amazonaws.com "cd /home/ec2-user/flightbot && docker-compose down && docker-compose build --no-cache && docker-compose up -d"
   ```

3. Wait 8 seconds, then tail the last 20 lines of the remote log to confirm startup:
   ```
   ssh -i "/Users/rafael/Desktop/Documentos/poc-dev-key.pem" -o StrictHostKeyChecking=no ec2-user@ec2-54-91-170-193.compute-1.amazonaws.com "sleep 8 && tail -20 /home/ec2-user/flightbot/results.log"
   ```

4. Report what was synced and whether the log shows "Bot started" without errors. If there are errors in the log, print them and stop — do not declare success.
