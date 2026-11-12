# Dedicated Studio tunnel

Run one remotely managed Cloudflare Tunnel dedicated to Studio. Its cloudflared
container lives beside the app in the same Compose project; it publishes no host
ports and reaches the origin at http://app:3000 over the private Docker network.
The app also publishes no host ports; diagnostics run through docker compose exec.

1. Create a remotely managed tunnel in the same Cloudflare account.
2. Configure ingress for the Studio hostname to http://app:3000, followed by a
   catch-all http_status:404 rule.
3. Install its tunnel token at secrets/cloudflared_token without echoing it or
   placing it in command arguments, Git, or logs. Use owner/group 65532:65532,
   mode 0400, inside the root-only secrets directory. Compose mounts only this
   token file into cloudflared, read-only; it does not give the connector any
   application or S3 credentials.
4. Start the connector with docker compose up -d cloudflared. It uses a pinned
   multi-architecture image and restart: unless-stopped. Inspect /ready on port
   2000 from inside the Compose network; that port is not published on the host.
5. Point the proxied hostname CNAME to <dedicated-tunnel-id>.cfargotunnel.com.
   Preserve the existing Access application, application audience, email OTP
   identity provider and dedicated Studio email policy. A routing migration does
   not require replacing the Access application or changing its audience.
6. Confirm an authenticated staff refresh succeeds through the new connector
   before deleting the previous ingress and retiring any SSH forwarding.

From the app host, verify readiness and origin connectivity without curl inside
the minimal containers:

    docker compose exec app node -e 'fetch("http://cloudflared:2000/ready").then(r=>console.log(r.status))'
    docker compose exec app node -e 'fetch("http://app:3000/studio").then(r=>console.log(r.status))'

Both should return 200. Cloudflare should report a healthy tunnel, and unsigned
public requests must still require Access login. Request metrics on port 2000
can confirm successful origin responses without recording login tokens.

Changing the token file by replacing its inode requires recreating the connector
so Docker remounts the new file. Updating the existing file in place does not.
