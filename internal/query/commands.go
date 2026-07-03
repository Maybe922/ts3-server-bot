package query

import (
	"fmt"
	"strconv"
)

// Session 是已登录并选定虚拟服务器的查询会话，按请求短连接使用。
type Session struct {
	c *Client
}

// Connect 建连、登录并选择 1 号虚拟服务器（单实例部署）。
func Connect(addr, user, password string) (*Session, error) {
	c, err := Dial(addr)
	if err != nil {
		return nil, err
	}
	if err := c.Login(user, password); err != nil {
		c.Close()
		return nil, fmt.Errorf("ServerQuery 登录失败: %w", err)
	}
	if err := c.Use(1); err != nil {
		c.Close()
		return nil, err
	}
	return &Session{c: c}, nil
}

func (s *Session) Close() { s.c.Close() }

// Overview 是服务器概览信息。
type Overview struct {
	Name          string `json:"name"`
	WelcomeMsg    string `json:"welcomeMsg"`
	ClientsOnline int    `json:"clientsOnline"`
	MaxClients    int    `json:"maxClients"`
	UptimeSeconds int    `json:"uptimeSeconds"`
	Port          string `json:"port"`
}

func (s *Session) Overview() (Overview, error) {
	entries, err := s.c.Exec("serverinfo")
	if err != nil {
		return Overview{}, err
	}
	if len(entries) == 0 {
		return Overview{}, fmt.Errorf("serverinfo 无返回数据")
	}
	info := entries[0]
	// 在线数包含 Query 客户端，展示时减去
	online := atoi(info["virtualserver_clientsonline"]) - atoi(info["virtualserver_queryclientsonline"])
	return Overview{
		Name:          info["virtualserver_name"],
		WelcomeMsg:    info["virtualserver_welcomemessage"],
		ClientsOnline: online,
		MaxClients:    atoi(info["virtualserver_maxclients"]),
		UptimeSeconds: atoi(info["virtualserver_uptime"]),
		Port:          info["virtualserver_port"],
	}, nil
}

// Rename 修改虚拟服务器名称（TS 客户端里看到的名字）。
func (s *Session) Rename(name string) error {
	_, err := s.c.Exec("serveredit virtualserver_name=" + Escape(name))
	return err
}

// SetWelcomeMsg 修改欢迎语。
func (s *Session) SetWelcomeMsg(msg string) error {
	_, err := s.c.Exec("serveredit virtualserver_welcomemessage=" + Escape(msg))
	return err
}

// OnlineClient 是一个在线的语音客户端。
type OnlineClient struct {
	ID        int    `json:"id"`
	ChannelID int    `json:"channelId"`
	Nickname  string `json:"nickname"`
}

// Clients 返回在线语音用户（过滤掉 Query 连接）。
func (s *Session) Clients() ([]OnlineClient, error) {
	entries, err := s.c.Exec("clientlist")
	if err != nil {
		return nil, err
	}
	clients := make([]OnlineClient, 0, len(entries))
	for _, e := range entries {
		if e["client_type"] != "0" { // 0=语音客户端 1=Query
			continue
		}
		clients = append(clients, OnlineClient{
			ID:        atoi(e["clid"]),
			ChannelID: atoi(e["cid"]),
			Nickname:  e["client_nickname"],
		})
	}
	return clients, nil
}

// Kick 将用户踢出服务器。
func (s *Session) Kick(clientID int, reason string) error {
	cmd := fmt.Sprintf("clientkick clid=%d reasonid=5", clientID)
	if reason != "" {
		cmd += " reasonmsg=" + Escape(reason)
	}
	_, err := s.c.Exec(cmd)
	return err
}

// Channel 是一个频道。
type Channel struct {
	ID       int    `json:"id"`
	ParentID int    `json:"parentId"`
	Name     string `json:"name"`
	Clients  int    `json:"clients"`
}

func (s *Session) Channels() ([]Channel, error) {
	entries, err := s.c.Exec("channellist")
	if err != nil {
		return nil, err
	}
	channels := make([]Channel, 0, len(entries))
	for _, e := range entries {
		channels = append(channels, Channel{
			ID:       atoi(e["cid"]),
			ParentID: atoi(e["pid"]),
			Name:     e["channel_name"],
			Clients:  atoi(e["total_clients"]),
		})
	}
	return channels, nil
}

// CreateChannel 创建一个永久频道。
func (s *Session) CreateChannel(name string) error {
	_, err := s.c.Exec("channelcreate channel_name=" + Escape(name) + " channel_flag_permanent=1")
	return err
}

// DeleteChannel 删除频道；频道内有人时拒绝（force=0）。
func (s *Session) DeleteChannel(channelID int) error {
	_, err := s.c.Exec(fmt.Sprintf("channeldelete cid=%d force=0", channelID))
	return err
}

func atoi(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}
