import net from "node:net";

const listenHost = process.env.AIBRAIN_INGRESS_LISTEN_HOST ?? "0.0.0.0";
const listenPort = Number(process.env.AIBRAIN_INGRESS_PORT ?? "3000");
const targetHost = process.env.AIBRAIN_INGRESS_TARGET_HOST ?? "app";
const targetPort = Number(process.env.AIBRAIN_INGRESS_TARGET_PORT ?? "3000");

if (listenHost !== "0.0.0.0" || listenPort !== 3000 || targetHost !== "app" || targetPort !== 3000) {
  throw new Error("AiBrain ingress target and listener must match the immutable Compose boundary.");
}

const server = net.createServer((client) => {
  const upstream = net.createConnection({ host: targetHost, port: targetPort });
  client.setNoDelay(true);
  upstream.setNoDelay(true);
  client.pipe(upstream);
  upstream.pipe(client);
  const close = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on("error", close);
  upstream.on("error", close);
  client.on("close", () => upstream.destroy());
  upstream.on("close", () => {
    // A clean readable end has already called client.end() through pipe().
    // Let that socket flush queued response bytes before it closes; destroying
    // it here truncates large responses for slower downstream connections.
    if (!upstream.readableEnded) client.destroy();
  });
});

server.on("error", (error) => {
  process.stderr.write(`AiBrain ingress gateway failed: ${error.message}\n`);
  process.exit(1);
});

server.listen({ host: listenHost, port: listenPort, exclusive: true });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
