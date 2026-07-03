package main

import (
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"io/fs"
	"log"
	"net/http"
	"time"

	"io"

	"ts3panel/internal/auth"
	"ts3panel/internal/musicbot"
	"ts3panel/internal/query"
	"ts3panel/internal/tsserver"
)

//go:embed web
var webFS embed.FS

const (
	version    = "0.3.1"
	cookieName = "ts3panel_session"
	queryAddr  = "127.0.0.1:10011"
)

type server struct {
	ts   *tsserver.Manager
	auth *auth.Store
	bot  *musicbot.Proxy
}

func main() {
	addr := flag.String("addr", ":8090", "面板监听地址")
	dataDir := flag.String("data", "data", "数据目录（存放 TS3 服务端、凭据、pid）")
	supervisor := flag.String("supervisor", "auto", "ts3server 托管方式: auto | systemd | direct")
	botConfig := flag.String("bot-config", "bot/data/config.json", "点歌 Bot 的配置文件路径")
	flag.Parse()

	static, err := fs.Sub(webFS, "web")
	if err != nil {
		log.Fatalf("加载内嵌前端资源失败: %v", err)
	}

	useSystemd := *supervisor == "systemd" ||
		(*supervisor == "auto" && tsserver.SystemdAvailable())
	mode := "direct（面板子进程，仅供开发调试）"
	if useSystemd {
		mode = "systemd（独立服务，与面板解耦）"
	}
	log.Printf("ts3server 托管方式: %s", mode)

	s := &server{
		ts:   tsserver.NewManager(*dataDir, useSystemd),
		auth: auth.NewStore(*dataDir),
		bot:  musicbot.NewProxy(*botConfig),
	}

	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.FS(static)))
	// 鉴权接口（公开）
	mux.HandleFunc("GET /api/auth/state", s.handleAuthState)
	mux.HandleFunc("POST /api/auth/setup", s.handleAuthSetup)
	mux.HandleFunc("POST /api/auth/login", s.handleLogin)
	mux.HandleFunc("POST /api/auth/logout", s.handleLogout)
	// 业务接口（需登录）
	mux.HandleFunc("GET /api/status", s.requireAuth(s.handleStatus))
	mux.HandleFunc("POST /api/server/install", s.requireAuth(s.handleInstall))
	mux.HandleFunc("POST /api/server/start", s.requireAuth(s.handleStart))
	mux.HandleFunc("POST /api/server/stop", s.requireAuth(s.handleStop))
	// 运维接口（ServerQuery）
	mux.HandleFunc("GET /api/ts/overview", s.requireAuth(s.handleOverview))
	mux.HandleFunc("POST /api/ts/rename", s.requireAuth(s.handleRename))
	mux.HandleFunc("GET /api/ts/clients", s.requireAuth(s.handleClients))
	mux.HandleFunc("POST /api/ts/kick", s.requireAuth(s.handleKick))
	mux.HandleFunc("GET /api/ts/channels", s.requireAuth(s.handleChannels))
	mux.HandleFunc("POST /api/ts/channels/create", s.requireAuth(s.handleChannelCreate))
	mux.HandleFunc("POST /api/ts/channels/delete", s.requireAuth(s.handleChannelDelete))
	// 点歌 Bot（代理到 Bot 的本机控制 API）
	mux.HandleFunc("GET /api/bot/status", s.requireAuth(s.botForward("GET", "/status")))
	mux.HandleFunc("POST /api/bot/search", s.requireAuth(s.botForward("POST", "/search")))
	mux.HandleFunc("POST /api/bot/play", s.requireAuth(s.botForward("POST", "/play")))
	mux.HandleFunc("POST /api/bot/playlist", s.requireAuth(s.botForward("POST", "/playlist")))
	mux.HandleFunc("POST /api/bot/shuffle", s.requireAuth(s.botForward("POST", "/shuffle")))
	mux.HandleFunc("POST /api/bot/skip", s.requireAuth(s.botForward("POST", "/skip")))
	mux.HandleFunc("POST /api/bot/stop", s.requireAuth(s.botForward("POST", "/stop")))
	mux.HandleFunc("POST /api/bot/volume", s.requireAuth(s.botForward("POST", "/volume")))
	mux.HandleFunc("POST /api/bot/netease/qr/start", s.requireAuth(s.botForward("POST", "/netease/qr/start")))
	mux.HandleFunc("POST /api/bot/netease/qr/check", s.requireAuth(s.botForward("POST", "/netease/qr/check")))
	mux.HandleFunc("GET /api/bot/netease/profile", s.requireAuth(s.botForward("GET", "/netease/profile")))
	mux.HandleFunc("POST /api/bot/netease/logout", s.requireAuth(s.botForward("POST", "/netease/logout")))
	// Bot 进程托管(systemd)
	mux.HandleFunc("GET /api/bot/svc", s.requireAuth(s.handleBotSvc))
	mux.HandleFunc("POST /api/bot/svc/start", s.requireAuth(s.handleBotSvcStart))
	mux.HandleFunc("POST /api/bot/svc/stop", s.requireAuth(s.handleBotSvcStop))

	log.Printf("ts3panel %s 已启动，监听 %s，数据目录 %s", version, *addr, *dataDir)
	if err := http.ListenAndServe(*addr, mux); err != nil {
		log.Fatalf("面板启动失败: %v", err)
	}
}

// respond 输出统一的 API 响应信封。
func respond(w http.ResponseWriter, status int, data any, errMsg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	body := map[string]any{"success": errMsg == "", "data": data, "error": nil}
	if errMsg != "" {
		body["error"] = errMsg
	}
	if err := json.NewEncoder(w).Encode(body); err != nil {
		log.Printf("编码响应失败: %v", err)
	}
}

// requireAuth 校验会话 Cookie，未登录返回 401。
func (s *server) requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie(cookieName)
		if err != nil || !s.auth.Valid(cookie.Value) {
			respond(w, http.StatusUnauthorized, nil, "未登录或会话已过期")
			return
		}
		next(w, r)
	}
}

func (s *server) handleAuthState(w http.ResponseWriter, r *http.Request) {
	loggedIn := false
	if cookie, err := r.Cookie(cookieName); err == nil {
		loggedIn = s.auth.Valid(cookie.Value)
	}
	respond(w, http.StatusOK, map[string]bool{
		"passwordSet": s.auth.HasPassword(),
		"loggedIn":    loggedIn,
	}, "")
}

func (s *server) handleAuthSetup(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respond(w, http.StatusBadRequest, nil, "请求格式错误")
		return
	}
	if err := s.auth.SetPassword(req.Password); err != nil {
		respond(w, http.StatusBadRequest, nil, err.Error())
		return
	}
	s.issueSession(w, req.Password)
}

func (s *server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respond(w, http.StatusBadRequest, nil, "请求格式错误")
		return
	}
	s.issueSession(w, req.Password)
}

// issueSession 校验密码并写入会话 Cookie。
func (s *server) issueSession(w http.ResponseWriter, password string) {
	token, err := s.auth.Login(password)
	if err != nil {
		status := http.StatusUnauthorized
		if errors.Is(err, auth.ErrPasswordNotSet) {
			status = http.StatusBadRequest
		}
		respond(w, status, nil, err.Error())
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     cookieName,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   7 * 24 * 3600,
	})
	respond(w, http.StatusOK, map[string]string{"message": "登录成功"}, "")
}

func (s *server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie(cookieName); err == nil {
		s.auth.Logout(cookie.Value)
	}
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: "", Path: "/", MaxAge: -1})
	respond(w, http.StatusOK, map[string]string{"message": "已退出"}, "")
}

func (s *server) handleStatus(w http.ResponseWriter, r *http.Request) {
	creds, hasCreds := s.ts.LoadCredentials()
	status := map[string]any{
		"panelVersion":    version,
		"serverVersion":   tsserver.Version,
		"serverInstalled": s.ts.Installed(),
		"serverRunning":   s.ts.Running(),
	}
	if hasCreds {
		status["credentials"] = creds
	}
	respond(w, http.StatusOK, status, "")
}

func (s *server) handleInstall(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AcceptLicense bool `json:"acceptLicense"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respond(w, http.StatusBadRequest, nil, "请求格式错误")
		return
	}
	if err := s.ts.Install(r.Context(), req.AcceptLicense); err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, tsserver.ErrLicenseNotAccepted) {
			status = http.StatusBadRequest
		}
		respond(w, status, nil, err.Error())
		return
	}
	respond(w, http.StatusOK, map[string]string{"message": "安装完成"}, "")
}

func (s *server) handleStart(w http.ResponseWriter, r *http.Request) {
	if err := s.ts.Start(); err != nil {
		respond(w, http.StatusInternalServerError, nil, err.Error())
		return
	}
	respond(w, http.StatusOK, map[string]string{"message": "已启动"}, "")
}

func (s *server) handleStop(w http.ResponseWriter, r *http.Request) {
	if err := s.ts.Stop(); err != nil {
		respond(w, http.StatusInternalServerError, nil, err.Error())
		return
	}
	respond(w, http.StatusOK, map[string]string{"message": "已停止"}, "")
}

// querySession 建立一条已登录的 ServerQuery 会话，调用方负责 Close。
// 服务器刚启动的几秒内端口尚未就绪，带短暂重试消除误报。
func (s *server) querySession() (*query.Session, error) {
	if !s.ts.Running() {
		return nil, errors.New("TS3 服务器未在运行")
	}
	creds, ok := s.ts.LoadCredentials()
	if !ok {
		return nil, errors.New("尚未获取到 Query 凭据，请先启动一次服务器")
	}
	var sess *query.Session
	var err error
	for attempt := 0; attempt < 3; attempt++ {
		if sess, err = query.Connect(queryAddr, creds.QueryUser, creds.QueryPassword); err == nil {
			return sess, nil
		}
		time.Sleep(700 * time.Millisecond)
	}
	return nil, err
}

// withQuery 处理会话建立/关闭的样板，把业务逻辑收敛到回调里。
func (s *server) withQuery(w http.ResponseWriter, fn func(*query.Session) (any, error)) {
	sess, err := s.querySession()
	if err != nil {
		respond(w, http.StatusServiceUnavailable, nil, err.Error())
		return
	}
	defer sess.Close()
	data, err := fn(sess)
	if err != nil {
		respond(w, http.StatusInternalServerError, nil, err.Error())
		return
	}
	respond(w, http.StatusOK, data, "")
}

func (s *server) handleOverview(w http.ResponseWriter, r *http.Request) {
	s.withQuery(w, func(sess *query.Session) (any, error) {
		return sess.Overview()
	})
}

func (s *server) handleRename(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Name == "" {
		respond(w, http.StatusBadRequest, nil, "服务器名称不能为空")
		return
	}
	s.withQuery(w, func(sess *query.Session) (any, error) {
		return map[string]string{"message": "已改名"}, sess.Rename(req.Name)
	})
}

func (s *server) handleClients(w http.ResponseWriter, r *http.Request) {
	s.withQuery(w, func(sess *query.Session) (any, error) {
		return sess.Clients()
	})
}

func (s *server) handleKick(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ClientID int    `json:"clientId"`
		Reason   string `json:"reason"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ClientID <= 0 {
		respond(w, http.StatusBadRequest, nil, "无效的用户 ID")
		return
	}
	s.withQuery(w, func(sess *query.Session) (any, error) {
		return map[string]string{"message": "已踢出"}, sess.Kick(req.ClientID, req.Reason)
	})
}

func (s *server) handleChannels(w http.ResponseWriter, r *http.Request) {
	s.withQuery(w, func(sess *query.Session) (any, error) {
		return sess.Channels()
	})
}

func (s *server) handleChannelCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Name == "" {
		respond(w, http.StatusBadRequest, nil, "频道名称不能为空")
		return
	}
	s.withQuery(w, func(sess *query.Session) (any, error) {
		return map[string]string{"message": "频道已创建"}, sess.CreateChannel(req.Name)
	})
}

// botForward 生成一个把请求原样转发给点歌 Bot 的处理器。
// Bot 与面板使用同款 JSON 信封，响应直接透传。
func (s *server) botForward(method, path string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<10))
		if err != nil {
			respond(w, http.StatusBadRequest, nil, "请求体过大或读取失败")
			return
		}
		status, respBody, err := s.bot.Forward(method, path, body)
		if err != nil {
			respond(w, http.StatusServiceUnavailable, nil, err.Error())
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		w.Write(respBody)
	}
}

func (s *server) handleBotSvc(w http.ResponseWriter, r *http.Request) {
	respond(w, http.StatusOK, musicbot.State(), "")
}

func (s *server) handleBotSvcStart(w http.ResponseWriter, r *http.Request) {
	if err := musicbot.StartService(); err != nil {
		respond(w, http.StatusInternalServerError, nil, err.Error())
		return
	}
	respond(w, http.StatusOK, map[string]string{"message": "机器人已启动"}, "")
}

func (s *server) handleBotSvcStop(w http.ResponseWriter, r *http.Request) {
	if err := musicbot.StopService(); err != nil {
		respond(w, http.StatusInternalServerError, nil, err.Error())
		return
	}
	respond(w, http.StatusOK, map[string]string{"message": "机器人已停止"}, "")
}

func (s *server) handleChannelDelete(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ChannelID int `json:"channelId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ChannelID <= 0 {
		respond(w, http.StatusBadRequest, nil, "无效的频道 ID")
		return
	}
	s.withQuery(w, func(sess *query.Session) (any, error) {
		return map[string]string{"message": "频道已删除"}, sess.DeleteChannel(req.ChannelID)
	})
}
