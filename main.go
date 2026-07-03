package main

import (
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"io/fs"
	"log"
	"net/http"

	"ts3panel/internal/auth"
	"ts3panel/internal/tsserver"
)

//go:embed web
var webFS embed.FS

const (
	version    = "0.1.0-dev"
	cookieName = "ts3panel_session"
)

type server struct {
	ts   *tsserver.Manager
	auth *auth.Store
}

func main() {
	addr := flag.String("addr", ":8090", "面板监听地址")
	dataDir := flag.String("data", "data", "数据目录（存放 TS3 服务端、凭据、pid）")
	flag.Parse()

	static, err := fs.Sub(webFS, "web")
	if err != nil {
		log.Fatalf("加载内嵌前端资源失败: %v", err)
	}

	s := &server{
		ts:   tsserver.NewManager(*dataDir),
		auth: auth.NewStore(*dataDir),
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
