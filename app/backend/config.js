function getEnvString(name, fallback = "") {
  const value = process.env[name];
  if (typeof value !== "string") return fallback;
  return value.trim();
}

module.exports = {
  getEnvString,
};
