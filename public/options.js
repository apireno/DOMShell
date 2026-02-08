const enableToggle = document.getElementById("enableToggle");
const tokenInput = document.getElementById("tokenInput");
const portInput = document.getElementById("portInput");
const saveBtn = document.getElementById("saveBtn");
const savedMsg = document.getElementById("savedMsg");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");

// -- Load saved state --
chrome.storage.local.get(["ws_enabled", "ws_token", "ws_port", "ws_status"], (result) => {
  enableToggle.checked = result.ws_enabled === true;
  tokenInput.value = result.ws_token || "";
  portInput.value = result.ws_port || 9876;
  updateStatus(result.ws_status || "disabled");
});

// -- Save --
saveBtn.addEventListener("click", () => {
  const enabled = enableToggle.checked;
  const token = tokenInput.value.trim();
  const port = parseInt(portInput.value, 10) || 9876;

  if (enabled && !token) {
    tokenInput.focus();
    tokenInput.style.borderColor = "#d93025";
    setTimeout(() => { tokenInput.style.borderColor = ""; }, 2000);
    return;
  }

  chrome.storage.local.set({
    ws_enabled: enabled,
    ws_token: token,
    ws_port: port,
  });

  // Flash "Saved"
  savedMsg.classList.add("show");
  setTimeout(() => savedMsg.classList.remove("show"), 2000);
});

// -- Live status updates from background --
chrome.storage.onChanged.addListener((changes) => {
  if (changes.ws_status) {
    updateStatus(changes.ws_status.newValue);
  }
});

function updateStatus(status) {
  statusDot.className = "status-dot " + (status || "disabled");
  const labels = {
    disabled: "Disabled",
    connecting: "Connecting...",
    connected: "Connected",
    disconnected: "Disconnected (retrying...)",
  };
  statusText.textContent = labels[status] || "Unknown";
}
