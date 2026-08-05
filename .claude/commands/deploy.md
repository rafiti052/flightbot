Deploy the latest flightbot code to EC2 and restart the container. Execute these steps in order:

0. All commands below assume `.env` (in `/Users/rafael/Dev/flightbot`) defines `SSH_KEY_PATH`, `SSH_USER`, `SSH_HOST`. Since each Bash call is a fresh shell, prefix every command with `source /Users/rafael/Dev/flightbot/.env &&` so the vars are in scope.

1. Rsync source files to EC2. Run each rsync separately:
   ```
   source /Users/rafael/Dev/flightbot/.env && rsync -avz -e "ssh -o StrictHostKeyChecking=no -i \"$SSH_KEY_PATH\"" /Users/rafael/Dev/flightbot/bot.js "$SSH_USER@$SSH_HOST:/home/ec2-user/flightbot/"
   source /Users/rafael/Dev/flightbot/.env && rsync -avz -e "ssh -o StrictHostKeyChecking=no -i \"$SSH_KEY_PATH\"" /Users/rafael/Dev/flightbot/Dockerfile "$SSH_USER@$SSH_HOST:/home/ec2-user/flightbot/"
   source /Users/rafael/Dev/flightbot/.env && rsync -avz -e "ssh -o StrictHostKeyChecking=no -i \"$SSH_KEY_PATH\"" /Users/rafael/Dev/flightbot/docker-compose.yml "$SSH_USER@$SSH_HOST:/home/ec2-user/flightbot/"
   source /Users/rafael/Dev/flightbot/.env && rsync -avz -e "ssh -o StrictHostKeyChecking=no -i \"$SSH_KEY_PATH\"" /Users/rafael/Dev/flightbot/package.json "$SSH_USER@$SSH_HOST:/home/ec2-user/flightbot/"
   source /Users/rafael/Dev/flightbot/.env && rsync -avz -e "ssh -o StrictHostKeyChecking=no -i \"$SSH_KEY_PATH\"" /Users/rafael/Dev/flightbot/package-lock.json "$SSH_USER@$SSH_HOST:/home/ec2-user/flightbot/"
   ```
   IMPORTANT: Do NOT sync config.json or prices.json — those files live on the server and must never be overwritten by a deploy.

2. Rebuild and restart the container on EC2:
   ```
   source /Users/rafael/Dev/flightbot/.env && ssh -i "$SSH_KEY_PATH" -o StrictHostKeyChecking=no "$SSH_USER@$SSH_HOST" "cd /home/ec2-user/flightbot && docker-compose down && docker-compose build --no-cache && docker-compose up -d"
   ```

3. Wait 8 seconds, then tail the last 20 lines of the remote log to confirm startup:
   ```
   source /Users/rafael/Dev/flightbot/.env && ssh -i "$SSH_KEY_PATH" -o StrictHostKeyChecking=no "$SSH_USER@$SSH_HOST" "sleep 8 && tail -20 /home/ec2-user/flightbot/results.log"
   ```

4. Report what was synced and whether the log shows "Bot started" without errors. If there are errors in the log, print them and stop — do not declare success.
