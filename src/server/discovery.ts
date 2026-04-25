import { networkInterfaces } from "os";
import dgram from "dgram";

const DISCOVERY_PORT = Number(process.env.DISCOVERY_PORT) || 7583;
const BEACON_INTERVAL = 3000;

export function getLocalIP(): string {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    const addrs = nets[name];
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal) {
        return addr.address;
      }
    }
  }
  return "127.0.0.1";
}

export function startDiscovery(port: number) {
  const localIP = getLocalIP();
  const beacon = JSON.stringify({
    service: "tonglen-clipboard",
    ip: localIP,
    port,
    timestamp: Date.now(),
  });

  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });

  socket.on("error", (err) => {
    console.error("[discovery] UDP error:", err.message);
  });

  socket.bind(DISCOVERY_PORT, () => {
    socket.setBroadcast(true);

    // Send beacon periodically
    const interval = setInterval(() => {
      const msg = Buffer.from(
        JSON.stringify({
          service: "tonglen-clipboard",
          ip: localIP,
          port,
          timestamp: Date.now(),
        }),
      );
      socket.send(msg, 0, msg.length, DISCOVERY_PORT, "255.255.255.255", (err) => {
        if (err) console.error("[discovery] broadcast error:", err.message);
      });
    }, BEACON_INTERVAL);

    // Listen for other instances
    socket.on("message", (msg, rinfo) => {
      if (rinfo.address === localIP) return; // ignore self
      try {
        const data = JSON.parse(msg.toString());
        if (data.service === "tonglen-clipboard") {
          console.log(`[discovery] Found peer at ${data.ip}:${data.port}`);
        }
      } catch {
        // ignore malformed
      }
    });

    console.log(`[discovery] Broadcasting on UDP ${DISCOVERY_PORT} (LAN IP: ${localIP})`);
  });

  return socket;
}
