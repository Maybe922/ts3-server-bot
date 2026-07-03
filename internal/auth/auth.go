// Package auth 提供面板的密码鉴权与会话管理。
// 首次使用时由用户在界面上设置管理密码（bcrypt 落盘），
// 之后凭密码换取会话 Cookie。会话存内存，面板重启后需重新登录。
package auth

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
)

const (
	sessionTTL = 7 * 24 * time.Hour
	// 密码错误时的惩罚延迟，迟滞在线爆破
	failDelay = time.Second
)

var (
	ErrPasswordSet    = errors.New("管理密码已设置，不能重复初始化")
	ErrPasswordNotSet = errors.New("尚未设置管理密码")
	ErrWrongPassword  = errors.New("密码错误")
	ErrWeakPassword   = errors.New("密码至少需要 8 位")
)

type Store struct {
	mu       sync.Mutex
	hashFile string
	sessions map[string]time.Time // token -> 过期时间
}

func NewStore(baseDir string) *Store {
	return &Store{
		hashFile: filepath.Join(baseDir, "panel-password.hash"),
		sessions: make(map[string]time.Time),
	}
}

// HasPassword 报告管理密码是否已初始化。
func (s *Store) HasPassword() bool {
	_, err := os.Stat(s.hashFile)
	return err == nil
}

// SetPassword 初始化管理密码，仅允许在未设置时调用。
func (s *Store) SetPassword(password string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.HasPassword() {
		return ErrPasswordSet
	}
	if len(password) < 8 {
		return ErrWeakPassword
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.hashFile), 0o755); err != nil {
		return err
	}
	return os.WriteFile(s.hashFile, hash, 0o600)
}

// Login 校验密码，成功返回新会话 token。
func (s *Store) Login(password string) (string, error) {
	hash, err := os.ReadFile(s.hashFile)
	if err != nil {
		return "", ErrPasswordNotSet
	}
	if bcrypt.CompareHashAndPassword(hash, []byte(password)) != nil {
		time.Sleep(failDelay)
		return "", ErrWrongPassword
	}
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	token := hex.EncodeToString(buf)

	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneLocked()
	s.sessions[token] = time.Now().Add(sessionTTL)
	return token, nil
}

// Valid 报告会话 token 是否有效。
func (s *Store) Valid(token string) bool {
	if token == "" {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	expiry, ok := s.sessions[token]
	if !ok || time.Now().After(expiry) {
		delete(s.sessions, token)
		return false
	}
	return true
}

// Logout 使会话失效。
func (s *Store) Logout(token string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sessions, token)
}

func (s *Store) pruneLocked() {
	now := time.Now()
	for token, expiry := range s.sessions {
		if now.After(expiry) {
			delete(s.sessions, token)
		}
	}
}
