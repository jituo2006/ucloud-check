import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { Button, Input, Layout, Toast } from "@douyinfe/semi-ui";

const { Header, Content, Footer } = Layout;

function OptionsApp() {
  const [token, setToken] = useState("");
  const [tokenStatus, setTokenStatus] = useState("未读取");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const chromeRuntime = useMemo(() => {
    return (globalThis as any).chrome as
      | {
          cookies?: {
            getAll: (
              details: { domain?: string; name?: string },
              callback: (cookies: Array<{ domain?: string; name?: string; value?: string }>) => void
            ) => void;
          };
          storage?: {
            local?: {
              get: (
                keys: string[] | string,
                callback: (items: { token?: string; username?: string; password?: string }) => void
              ) => void;
              set: (items: { token?: string; username?: string; password?: string }, callback?: () => void) => void;
            };
          };
          tabs?: {
            create: (createProperties: { url: string }) => void;
          };
        }
      | undefined;
  }, []);

  const refreshTokenFromStorage = () => {
    chromeRuntime?.storage?.local?.get(["token", "username", "password"], (items) => {
      if (items?.token) {
        setToken(items.token);
        setTokenStatus("已保存到插件存储");
      } else {
        setTokenStatus("插件存储中无 token");
      }
      if (items?.username) {
        setUsername(items.username);
      }
      if (items?.password) {
        setPassword(items.password);
      }
    });
  };

  useEffect(() => {
    refreshTokenFromStorage();
  }, []);

  const openLogin = () => {
    chromeRuntime?.tabs?.create?.({ url: "https://ucloud.bupt.edu.cn/" });
  };

  const readFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      const val = text?.trim();
      if (val && val.length > 20) { // 简单检查长度
        setToken(val);
        chromeRuntime?.storage?.local?.set?.({ token: val }, () => {
          setTokenStatus("已从剪贴板读取并保存");
          Toast.success("读取成功");
        });
      } else {
        Toast.error("剪贴板中没有找到类似 Token 的字符串");
      }
    } catch (e) {
      console.error(e);
      Toast.error("读取剪贴板失败，请允许权限或手动在下方粘贴");
    }
  };

  const readFromCookie = () => {
    if (!chromeRuntime?.cookies?.getAll) {
      Toast.error("当前环境无法读取 Cookie");
      return;
    }
    const domains = ["ucloud.bupt.edu.cn", "apiucloud.bupt.edu.cn"];
    const possibleNames = ["iClass-token", "token", "access_token", "jwt"];
    let found = false;
    for (const domain of domains) {
      for (const name of possibleNames) {
        chromeRuntime.cookies.getAll(
          { domain, name },
          (cookies) => {
            if (found) return;
            const value = cookies?.[0]?.value;
            if (value) {
              chromeRuntime?.storage?.local?.set?.({ token: value }, () => {
                setToken(value);
                setTokenStatus(`已从 Cookie 读取并保存 (${domain}: ${name})`);
                Toast.success(`读取成功 (${domain}: ${name})`);
                found = true;
              });
            }
          }
        );
      }
    }
    setTimeout(() => {
      if (!found) {
        setTokenStatus("未在 Cookie 中找到 token");
        Toast.error("未读取到 Cookie，请先登录");
      }
    }, 2000);
  };

  const listAllCookies = () => {
    if (chromeRuntime?.cookies?.getAll) {
      const domains = ["ucloud.bupt.edu.cn", "apiucloud.bupt.edu.cn"];
      domains.forEach(domain => {
        if (chromeRuntime.cookies) {
          chromeRuntime.cookies.getAll({ domain }, (cookies) => {
            const cookieList = cookies.map(c => `${c.name}: ${c.value}`).join('\n');
            console.log(`${domain} cookies:`, cookieList);
          });
        }
      });
      Toast.info('请查看控制台的 cookie 列表');
    }
  };

  const saveManualToken = () => {
    if (!token) {
      Toast.error("请输入 token");
      return;
    }
    chromeRuntime?.storage?.local?.set?.({ token }, () => {
      setTokenStatus("已手动保存到插件存储");
      Toast.success("保存成功");
    });
  };

  const saveCredentials = () => {
    if (!username || !password) {
      Toast.error("请输入用户名和密码");
      return;
    }
    chromeRuntime?.storage?.local?.set?.({ username, password }, () => {
      Toast.success("凭据保存成功");
    });
  };

  return (
    <Layout style={{ maxWidth: 900, margin: "0 auto" }}>
      <Header style={{ minHeight: 64, lineHeight: "64px" }}>
        <div className="flex items-center px-4">
          <div className="font-semibold">UCloud Check 设置</div>
        </div>
      </Header>
      <Content style={{ padding: 16 }}>
        <div className="mb-4 text-sm text-gray-600">
          <strong>第一步：</strong>点击“打开 UCloud 登录页面”，在新标签页完成登录。<br />
          <strong>第二步：</strong>登录成功后，插件会自动保存 Token 并复制到您的剪贴板。<br />
          <strong>第三步：</strong>回到本页面，刷新页面，或点击下方按钮手动更新。
        </div>

        <div className="flex flex-wrap gap-2 mb-4">
          <Button onClick={openLogin}>打开 UCloud 登录页面</Button>
          <Button onClick={refreshTokenFromStorage} type="primary">刷新状态</Button>
          <Button onClick={readFromClipboard}>从剪贴板读取</Button>
          <Button onClick={readFromCookie}>从 Cookie 读取(备用)</Button>
          <Button onClick={listAllCookies}>列出所有 Cookies</Button>
        </div>

        <div className="mb-4">当前状态：{tokenStatus}</div>

        <div className="mb-2">手动输入 token（可选）：</div>
        <Input
          value={token}
          onChange={(v) => setToken(v)}
          placeholder="iClass-token"
        />
        <div className="mt-2 mb-4">
          <Button onClick={saveManualToken}>保存 token</Button>
        </div>

        <div className="mb-2">自动登录设置（实验性）：</div>
        <div className="mb-2">
          <Input
            value={username}
            onChange={(v) => setUsername(v)}
            placeholder="用户名"
          />
        </div>
        <div className="mb-2">
          <Input
            value={password}
            onChange={(v) => setPassword(v)}
            placeholder="密码"
            type="password"
          />
        </div>
        <div className="mt-2">
          <Button onClick={saveCredentials}>保存凭据</Button>
        </div>
      </Content>
      <Footer style={{ minHeight: 48, lineHeight: "48px" }}>
        <div className="text-center text-xs text-gray-500">
          本插件不进行自动化登录，仅读取已登录会话的 Cookie。
        </div>
      </Footer>
    </Layout>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <OptionsApp />
  </StrictMode>
);
