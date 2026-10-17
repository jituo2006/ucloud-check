const tryFindToken = () => {
  // UCloud 可能会把 token 存放在 localStorage 或 sessionStorage 中
  const token =
    window.sessionStorage.getItem("token") ||
    window.sessionStorage.getItem("iClass-token") ||
    window.localStorage.getItem("token") ||
    window.localStorage.getItem("iClass-token") ||
    window.sessionStorage.getItem("Blade-Auth") ||
    window.localStorage.getItem("Blade-Auth");

  const chromeRuntime = (window as any).chrome;

  if (token && chromeRuntime?.storage?.local) {
    chromeRuntime.storage.local.get(["token"], (res: any) => {
      if (res.token !== token) {
        chromeRuntime.storage.local.set({ token }, () => {
          console.log("[UCloud Check] Token 已自动提取并保存到插件！");

          // 自动写入剪贴板（作为双重保障），用户也可以手动去粘贴
          if (navigator.clipboard) {
            navigator.clipboard.writeText(token).catch(() => {});
          }

          // 在页面上弹出一个显眼的提示
          const div = document.createElement("div");
          div.style.position = "fixed";
          div.style.top = "20px";
          div.style.left = "50%";
          div.style.transform = "translateX(-50%)";
          div.style.padding = "15px 30px";
          div.style.background = "#00bcd4";
          div.style.color = "white";
          div.style.zIndex = "999999";
          div.style.borderRadius = "8px";
          div.style.boxShadow = "0 4px 12px rgba(0,0,0,0.2)";
          div.style.fontSize = "16px";
          div.innerHTML = `
            <div style="font-weight: bold; margin-bottom: 5px;">UCloud Check 插件：登录成功！</div>
            <div style="font-size: 14px;">Token 已自动同步到插件，并复制到您的剪贴板。<br/>您可以直接关闭此页面回到插件设置。</div>
          `;
          document.body.appendChild(div);

          setTimeout(() => {
            div.remove();
          }, 8000);
        });
      }
    });
  }
};

// 应对单页应用的路由变化，轮询检查
setInterval(tryFindToken, 1500);
window.addEventListener("load", tryFindToken);
