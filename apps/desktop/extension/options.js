const tokenInput = document.getElementById("token");
const status = document.getElementById("status");

function show(message, ok) {
  status.textContent = message;
  status.className = ok ? "ok" : "bad";
}

chrome.storage.local.get(["token"]).then((stored) => {
  if (stored.token) {
    tokenInput.value = stored.token;
    show("Connected. You can close this.", true);
  }
});

document.getElementById("save").addEventListener("click", async () => {
  const token = tokenInput.value.trim();
  if (!token) {
    show("Paste the code from WorkCrew Settings first.", false);
    return;
  }
  await chrome.storage.local.set({ token: token, port: 8317 });
  // Prove the code works now rather than letting the user discover it was
  // wrong the next time they ask WorkCrew to do something.
  try {
    const response = await fetch("http://127.0.0.1:8317/poll", {
      method: "GET",
      headers: { Authorization: "Bearer " + token }
    });
    if (response.status === 401) show("WorkCrew rejected that code. Copy it again from Settings.", false);
    else show("Connected to WorkCrew.", true);
  } catch (error) {
    show("Saved, but WorkCrew is not running. Open the app and it will connect.", false);
  }
});
