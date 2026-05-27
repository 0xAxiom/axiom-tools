export default function handler(req, res) {
  res.status(200).json({
    status: "ok",
    service: "axiom-tools",
    time: new Date().toISOString(),
  });
}
