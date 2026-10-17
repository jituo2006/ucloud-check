import "./App.css";

import { Button, Input, Layout, List, Modal, Toast } from "@douyinfe/semi-ui";
import { useEffect, useRef, useState } from "react";
import {
  getAttendanceEncryptionParam,
  getCheckoutBasic,
  getGoingSite,
  getStudentSiteList,
  getUserInfo,
  login,
  sign,
  type GoingSite,
  type Site,
  type UserInfo,
} from "./req";
import { base64Decode } from "./utils";
import { CheckCode } from "./CheckCode";

function App() {
  const { Header, Footer, Content } = Layout;

  const chromeRuntime = (globalThis as any).chrome as
    | {
        cookies?: {
          get: (
            details: { url: string; name: string },
            callback: (cookie?: { value?: string }) => void
          ) => void;
          getAll: (
            details: { domain?: string; name?: string },
            callback: (cookies: Array<{ value?: string }>) => void
          ) => void;
        };
        storage?: {
          local?: {
            get: (
              keys: string[] | string,
              callback: (items: any) => void
            ) => void;
            set: (items: { token?: string; username?: string; password?: string }, callback?: () => void) => void;
          };
        };
        runtime?: {
          openOptionsPage?: () => void;
        };
      }
    | undefined;

  const [loginVisible, setLoginVisible] = useState(false);
  const [qrcodeVisible, setQrcodeVisible] = useState(false);

  const [inputToken, setInputToken] = useState("");
  const [inputSiteId, setInputSiteId] = useState("");
  const [inputGroupId, setInputGroupId] = useState("");
  const [genCheckworkId, setGenCheckworkId] = useState("");

  const [info, setInfo] = useState<UserInfo>();
  const [tokenExp, setTokenExp] = useState(0);
  const [siteList, setSiteList] = useState<Site[]>([]);
  const [goingSiteList, setGoingSiteList] = useState<GoingSite[]>([]);
  const [goingSiteIdList, setGoingSiteIdList] = useState<string[]>([]);

  const commonStyle = {
    minHeight: 64,
    lineHeight: "64px",
    background: "var(--semi-color-fill-0)",
  };

  const checkToken = () => {
    getUserInfo()
      .then((r) => {
        setInfo(r.data.data);
        const token = sessionStorage.getItem("token");
        const data = token?.split(".")[1] ?? "";
        const decodedData = base64Decode(data);
        const jwtPayload = JSON.parse(decodedData);
        // console.log(jwtPayload);
        setTokenExp(jwtPayload.exp);
        Toast.info("设置成功");
        setLoginVisible(false);

        updateSiteList();
      })
      .catch((e) => {
        console.log(e);
        Toast.error(e.response.data.message);
      });
  };

  const autoLogin = (username: string, password: string) => {
    login(username, password)
      .then((r) => {
        const token = r.data.data.token; // 假设响应中有 token
        sessionStorage.setItem("token", token);
        chromeRuntime?.storage?.local?.set?.({ token });
        checkToken();
        Toast.success("自动登录成功");
      })
      .catch((e) => {
        console.log(e);
        Toast.error("自动登录失败，可能被反自动化措施拦截: " + e.response?.data?.message);
      });
  };

  const updateSiteList = () => {
    if (!info) return;
    getStudentSiteList(info.id)
      .then((r) => {
        setSiteList(r.data.data.records);
      })
      .catch((e) => {
        console.log(e);
        Toast.error(e.response.data.message);
      });
  };

  useEffect(() => {
    updateSiteList();
  }, [info]);

  const updateGoingList = () => {
    if (!siteList || siteList.length <= 0) return;
    getGoingSite(
      siteList.map((t) => {
        return t.id;
      })
    )
      .then((r) => {
        setGoingSiteList(r.data.data);
        setGoingSiteIdList(r.data.data.map((t: GoingSite) => t.siteId));
      })
      .catch((e) => {
        console.log(e);
        Toast.error(e.response.data.message);
      });
  };

  useEffect(() => {
    updateGoingList();
  }, [siteList]);

  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;

      const chromeRuntime = (globalThis as any).chrome as
        | {
            cookies?: {
              get: (
                details: { url: string; name: string },
                callback: (cookie?: { value?: string }) => void
              ) => void;
              getAll: (
                details: { domain?: string; name?: string },
                callback: (cookies: Array<{ value?: string }>) => void
              ) => void;
            };
            storage?: {
              local?: {
                get: (
                  keys: string[] | string,
                  callback: (items: any) => void
                ) => void;
                set: (items: any, callback?: () => void) => void;
              };
            };
            runtime?: {
              openOptionsPage?: () => void;
            };
          }
        | undefined;

      const openOptionsIfNeeded = () => {
        chromeRuntime?.runtime?.openOptionsPage?.();
      };

      const tryStorageToken = () => {
        if (chromeRuntime?.storage?.local?.get) {
          chromeRuntime.storage.local.get(["token", "username", "password"], (items) => {
            if (items?.token) {
              sessionStorage.setItem("token", items.token);
              checkToken();
            } else if (items?.username && items?.password) {
              autoLogin(items.username, items.password);
            } else {
              Toast.error("未找到 token，请在设置页首次填写");
              openOptionsIfNeeded();
            }
          });
        } else {
          checkToken();
        }
      };

      if (chromeRuntime?.cookies?.getAll) {
        chromeRuntime.cookies.getAll(
          { domain: "ucloud.bupt.edu.cn", name: "iClass-token" },
          (cookies) => {
            const value = cookies?.[0]?.value;
            if (value) {
              sessionStorage.setItem("token", value);
              chromeRuntime?.storage?.local?.set?.({ token: value });
              checkToken();
              return;
            }
            if (chromeRuntime?.cookies?.get) {
              chromeRuntime.cookies.get(
                {
                  url: "https://ucloud.bupt.edu.cn/",
                  name: "iClass-token",
                },
                (cookie) => {
                  if (cookie?.value) {
                    sessionStorage.setItem("token", cookie.value);
                    chromeRuntime?.storage?.local?.set?.({ token: cookie.value });
                    checkToken();
                  } else {
                    tryStorageToken();
                  }
                }
              );
            } else {
              tryStorageToken();
            }
          }
        );
      } else if (chromeRuntime?.cookies?.get) {
        chromeRuntime.cookies.get(
          {
            url: "https://ucloud.bupt.edu.cn/",
            name: "iClass-token",
          },
          (cookie) => {
            if (cookie?.value) {
              sessionStorage.setItem("token", cookie.value);
              chromeRuntime?.storage?.local?.set?.({ token: cookie.value });
              checkToken();
            } else {
              tryStorageToken();
            }
          }
        );
      } else {
        checkToken();
      }
    }
    return () => {
      console.log("de");
    };
  }, []);

  const autoSign = (siteId: string, groupId: string) => {
    if (!info?.id) return;
    getCheckoutBasic(siteId, groupId)
      .then((r) => {
        const attendanceId = r.data.data.attendanceBasicInfo.id;
        if (attendanceId <= 0) {
          Toast.error("未找到签到ID");
          return;
        }
        getAttendanceEncryptionParam().then((r) => {
          const clockV2 = r.data.data.data;
          sign(attendanceId, siteId, info.id, groupId, clockV2).then(() => {
            Toast.success("签到成功");
          });
        });
      })
      .catch((e) => {
        console.log(e);
        Toast.error(e.response.data.message);
      });
  };

  return (
    <Layout
      style={{
        maxWidth: 800,
        margin: "auto",
      }}
    >
      <Header style={commonStyle}>
        <div className="flex items-center">
          <Button
            className="m-2"
            onClick={() => {
              setLoginVisible(true);
            }}
          >
            设置令牌
          </Button>
          <Button
            className="m-2"
            onClick={() => {
              const chromeRuntime = (globalThis as any).chrome as
                | {
                    runtime?: {
                      openOptionsPage?: () => void;
                    };
                  }
                | undefined;
              if (chromeRuntime?.runtime?.openOptionsPage) {
                chromeRuntime.runtime.openOptionsPage();
              } else {
                Toast.info("请从浏览器扩展详情进入设置页");
              }
            }}
          >
            插件设置
          </Button>
          {info && <div>当前用户：{info.account}</div>}
          {tokenExp > 0 && (
            <div className="ml-2">
              令牌至：{new Date(tokenExp * 1000).toLocaleString()}
            </div>
          )}
          {info && (
            <Button
              className="m-2"
              onClick={() => {
                setQrcodeVisible(true);
              }}
            >
              生成码
            </Button>
          )}
        </div>
      </Header>
      <Content style={{ lineHeight: "300px" }}>
        <Modal
          title="设置令牌"
          visible={loginVisible}
          onOk={() => {
            // console.log(inputToken);
            sessionStorage.setItem("token", inputToken);
            checkToken();
          }}
          onCancel={() => {
            setLoginVisible(false);
          }}
          closeOnEsc={true}
        >
          请填写 token (Blade-Auth)
          <Input
            className="mt-2"
            onChange={(v) => {
              setInputToken(v);
            }}
          ></Input>
        </Modal>

        <Modal
          title="生成"
          visible={qrcodeVisible}
          onOk={() => {
            setQrcodeVisible(false);
          }}
          onCancel={() => {
            setQrcodeVisible(false);
          }}
          footer={<></>}
          closeOnEsc={true}
        >
          <div className="m-2">请输入 SiteId</div>
          <Input
            className="m-2"
            placeholder="SiteId"
            defaultValue={inputSiteId}
            onChange={(v) => {
              setInputSiteId(v);
            }}
          ></Input>
          <div className="m-2">请输入 GroupId (ClassLessonId)</div>
          <Input
            className="m-2"
            placeholder="GroupId (ClassLessonId)"
            defaultValue={inputGroupId}
            onChange={(v) => {
              setInputGroupId(v);
            }}
          ></Input>
          <Button
            className="m-2"
            onClick={() => {
              if (!inputSiteId) {
                Toast.error("SiteId 无效");
                return;
              }
              Toast.info("正在获取签到信息");
              getCheckoutBasic(inputSiteId, inputGroupId)
                .then((r) => {
                  const attendanceId = r.data.data.attendanceBasicInfo.id;
                  if (attendanceId <= 0) {
                    Toast.error("未找到签到ID");
                    setGenCheckworkId("");
                    return;
                  }
                  setGenCheckworkId(attendanceId);
                  Toast.info("获取成功");
                })
                .catch((e) => {
                  console.log(e.response.data);
                  Toast.error(e.response.data.message);
                });
            }}
          >
            生成
          </Button>
          {genCheckworkId && inputGroupId && (
            <div className="m-2">
              <CheckCode
                checkworkId={genCheckworkId}
                siteId={inputSiteId}
                classLessonId={inputGroupId}
              />
            </div>
          )}
        </Modal>

        <List
          dataSource={siteList}
          renderItem={(item) => (
            <List.Item
              main={
                <div>
                  <span
                    style={{
                      color: "var(--semi-color-text-0)",
                      fontWeight: 500,
                    }}
                  >
                    {item.siteName}
                  </span>
                </div>
              }
              extra={
                <Button
                  disabled={goingSiteIdList.indexOf(item.id) == -1}
                  onClick={() => {
                    const goingSite = goingSiteList.find((v) => {
                      if (v.siteId == item.id) {
                        return v;
                      }
                    });
                    if (!goingSite) {
                      Toast.error("未找到有效信息");
                      return;
                    }
                    autoSign(goingSite.siteId, goingSite.groupId);
                  }}
                >
                  签到
                </Button>
              }
            />
          )}
        />
      </Content>
      <Footer style={commonStyle}>Footer</Footer>
    </Layout>
  );
}

export default App;
