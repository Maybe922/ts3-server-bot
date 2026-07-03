// Package query 实现 TS3 ServerQuery 协议客户端（telnet 风格，面板连本机 10011）。
// 协议参考：服务端安装包 doc/serverquery/。
package query

import (
	"bufio"
	"fmt"
	"net"
	"strings"
	"time"
)

const ioTimeout = 5 * time.Second

// Client 是一条 ServerQuery 连接。用法：Dial → Login → Use → Exec... → Close。
type Client struct {
	conn net.Conn
	r    *bufio.Reader
}

// Dial 建立连接并消费欢迎横幅。
func Dial(addr string) (*Client, error) {
	conn, err := net.DialTimeout("tcp", addr, ioTimeout)
	if err != nil {
		return nil, fmt.Errorf("连接 ServerQuery 失败: %w", err)
	}
	c := &Client{conn: conn, r: bufio.NewReader(conn)}
	// 横幅两行："TS3" + "Welcome to the TeamSpeak 3 ServerQuery interface..."
	for i := 0; i < 2; i++ {
		if _, err := c.readLine(); err != nil {
			conn.Close()
			return nil, fmt.Errorf("读取欢迎信息失败: %w", err)
		}
	}
	return c, nil
}

func (c *Client) Close() {
	fmt.Fprint(c.conn, "quit\n")
	c.conn.Close()
}

func (c *Client) Login(user, password string) error {
	_, err := c.Exec(fmt.Sprintf("login %s %s", Escape(user), Escape(password)))
	return err
}

// Use 选择要操作的虚拟服务器（单实例场景固定 sid=1）。
func (c *Client) Use(sid int) error {
	_, err := c.Exec(fmt.Sprintf("use sid=%d", sid))
	return err
}

// Exec 发送命令并解析响应。返回数据行解析出的条目列表（可能为空）。
func (c *Client) Exec(cmd string) ([]map[string]string, error) {
	c.conn.SetDeadline(time.Now().Add(ioTimeout))
	if _, err := fmt.Fprintf(c.conn, "%s\n", cmd); err != nil {
		return nil, fmt.Errorf("发送命令失败: %w", err)
	}

	var entries []map[string]string
	for {
		line, err := c.readLine()
		if err != nil {
			return nil, fmt.Errorf("读取响应失败: %w", err)
		}
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "error ") {
			return entries, parseError(line)
		}
		entries = append(entries, parseEntries(line)...)
	}
}

func (c *Client) readLine() (string, error) {
	c.conn.SetReadDeadline(time.Now().Add(ioTimeout))
	line, err := c.r.ReadString('\n')
	if err != nil {
		return "", err
	}
	return strings.Trim(line, "\r\n "), nil
}

// parseError 解析结尾的 error 行，id=0 表示成功。
func parseError(line string) error {
	fields := parseKV(line)
	if fields["id"] == "0" {
		return nil
	}
	msg := fields["msg"]
	if extra := fields["extra_msg"]; extra != "" {
		msg += " (" + extra + ")"
	}
	return fmt.Errorf("服务器返回错误 [%s]: %s", fields["id"], msg)
}

// parseEntries 解析数据行，条目间以 | 分隔。
func parseEntries(line string) []map[string]string {
	parts := strings.Split(line, "|")
	entries := make([]map[string]string, 0, len(parts))
	for _, part := range parts {
		entries = append(entries, parseKV(part))
	}
	return entries
}

// parseKV 解析 "key=value key2=value2" 格式，值做反转义。
func parseKV(s string) map[string]string {
	fields := make(map[string]string)
	for _, pair := range strings.Fields(s) {
		key, value, _ := strings.Cut(pair, "=")
		fields[key] = Unescape(value)
	}
	return fields
}

var escaper = strings.NewReplacer(
	`\`, `\\`, `/`, `\/`, ` `, `\s`, `|`, `\p`,
	"\a", `\a`, "\b", `\b`, "\f", `\f`, "\n", `\n`, "\r", `\r`, "\t", `\t`, "\v", `\v`,
)

var unescaper = strings.NewReplacer(
	`\\`, `\`, `\/`, `/`, `\s`, ` `, `\p`, `|`,
	`\a`, "\a", `\b`, "\b", `\f`, "\f", `\n`, "\n", `\r`, "\r", `\t`, "\t", `\v`, "\v",
)

// Escape 按 ServerQuery 规则转义参数值。
func Escape(s string) string { return escaper.Replace(s) }

// Unescape 反转义响应中的值。
func Unescape(s string) string { return unescaper.Replace(s) }
