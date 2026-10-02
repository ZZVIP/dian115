// 豆瓣最新榜单订阅插件。
//
// 它演示一个"取外部数据 → 缓存 → 定时复查 → 有变化就通知"的订阅型插件应当怎么
// 写：所有出网请求走 Host Broker，持久化走 Host Storage，定时复查用 manifest 声明
// 的 job（插件自己不跑循环，因此空闲时会被宿主释放），JSON 用 pluginjson 做字段级
// 读写以保持模块体积。
package main

import (
	"context"
	"encoding/base64"
	"errors"
	goruntime "runtime"
	"strings"
	"sync"
	"time"
	"unsafe"

	"example.com/dian115-plugin-sdk/pluginjson"
)

const protocol = "dian115:wasm@1"
const frameSize = 16 << 20

const (
	storagePath  = "/api/plugin-runtime/storage/douban-chart"
	notifyPath   = "/api/notifications/plugin"
	chartBase    = "https://m.douban.com/rexxar/api/v2/subject_collection/"
	defaultChart = "showing"
)

// 榜单 key 到豆瓣 collection 的映射。这些 collection 是豆瓣移动端接口公开使用的
// 标识，插件只做只读拉取。
var chartCatalog = []struct{ Key, Collection, Label string }{
	{"showing", "movie_showing", "正在上映"},
	{"weekly", "movie_weekly_best", "一周口碑榜"},
	{"latest", "movie_latest", "新片榜"},
	{"tv-cn", "tv_chinese_best_weekly", "华语口碑剧集榜"},
	{"tv-global", "tv_global_best_weekly", "全球口碑剧集榜"},
}

func chartCollection(key string) (string, string, bool) {
	for _, entry := range chartCatalog {
		if entry.Key == key {
			return entry.Collection, entry.Label, true
		}
	}
	return "", "", false
}

type chartItem struct {
	ID     string
	Title  string
	Year   string
	Rating string
	URL    string
}

type snapshot struct {
	mu         sync.Mutex
	chart      string
	subscribed bool
	items      []chartItem
	seen       map[string]bool
	updatedAt  string
	version    int
}

type peer struct{}

//go:wasmimport dian115 host_call
func hostCall(ptr, length uint32) uint32

//go:wasmimport dian115 host_read
func hostRead(ptr, capacity uint32) uint32

// call 发一次 JSON-RPC 给宿主并返回 result 的原始 JSON。
func (p *peer) call(ctx context.Context, method string, params map[string]any) (pluginjson.Raw, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	request, err := pluginjson.Encode(map[string]any{"method": method, "params": params})
	if err != nil {
		return nil, err
	}
	size := hostCall(uint32(uintptr(unsafe.Pointer(&request[0]))), uint32(len(request)))
	goruntime.KeepAlive(request)
	if size == 0 || size > frameSize {
		return nil, errors.New("invalid host response size")
	}
	response := make([]byte, size)
	if hostRead(uint32(uintptr(unsafe.Pointer(&response[0]))), size) != size {
		return nil, errors.New("host response read failed")
	}
	if text := pluginjson.Text(pluginjson.Field(response, "error")); text != "" {
		return nil, errors.New(text)
	}
	return pluginjson.Field(response, "result"), nil
}

// hostResult 是一次 Broker 调用的结果。
type hostResult struct {
	status int
	body   []byte
}

func (r *runtime) broker(ctx context.Context, method, path string, headers map[string]string, body []byte) (hostResult, error) {
	params := map[string]any{"method": method, "path": path}
	if len(headers) > 0 {
		params["headers"] = headers
	}
	if len(body) > 0 {
		params["body_base64"] = base64.RawStdEncoding.EncodeToString(body)
	}
	result, err := r.peer.call(ctx, "host.call", params)
	if err != nil {
		return hostResult{}, err
	}
	encoded := pluginjson.Text(pluginjson.Field(result, "body_base64"))
	decoded, _ := base64.RawStdEncoding.DecodeString(encoded)
	return hostResult{status: pluginjson.Int(pluginjson.Field(result, "status")), body: decoded}, nil
}

var inputBuffer, outputBuffer []byte
var guest = newRuntime(&peer{})

//go:wasmexport dian115_alloc
func allocate(size uint32) uint32 {
	if size == 0 || size > frameSize {
		panic("invalid input size")
	}
	inputBuffer = make([]byte, size)
	return uint32(uintptr(unsafe.Pointer(&inputBuffer[0])))
}

//go:wasmexport dian115_handle
func handle(ptr, length uint32) uint64 {
	if length == 0 || length > frameSize {
		panic("invalid invocation size")
	}
	raw := unsafe.Slice((*byte)(unsafe.Pointer(uintptr(ptr))), int(length))
	var result any
	var rpcErr *rpcError
	method := pluginjson.Text(pluginjson.Field(raw, "method"))
	if method == "" {
		rpcErr = &rpcError{-32602, "invalid invocation"}
	} else {
		result, rpcErr = guest.handle(method, pluginjson.Field(raw, "params"))
	}
	response := map[string]any{}
	if rpcErr != nil {
		response["error"] = map[string]any{"code": rpcErr.Code, "message": rpcErr.Message}
	} else {
		response["result"] = result
	}
	envelope, err := pluginjson.Encode(response)
	if err != nil {
		panic(err)
	}
	outputBuffer = envelope
	return uint64(uintptr(unsafe.Pointer(&outputBuffer[0])))<<32 | uint64(len(outputBuffer))
}

type rpcError struct {
	Code    int
	Message string
}

type runtime struct {
	peer *peer
	snap snapshot
}

func newRuntime(channel *peer) *runtime {
	return &runtime{peer: channel, snap: snapshot{chart: defaultChart, seen: map[string]bool{}}}
}

func (r *runtime) handle(method string, params pluginjson.Raw) (any, *rpcError) {
	switch method {
	case "runtime.initialize":
		if pluginjson.Text(pluginjson.Field(params, "protocol")) != protocol {
			return nil, &rpcError{-32602, "unsupported runtime protocol"}
		}
		if err := r.restore(); err != nil {
			// 读不到历史状态不算致命：从默认状态开始，下一次抓取会重新建立基线。
			r.log("warning", "restore subscription state failed", err)
		}
		return map[string]any{"ready": true, "protocol": protocol}, nil
	case "runtime.invoke":
		envelope := pluginjson.Field(params, "envelope")
		op := pluginjson.Text(pluginjson.Field(envelope, "op"))
		invocationID := pluginjson.Text(pluginjson.Field(envelope, "invocation_id"))
		payload := pluginjson.Field(envelope, "payload")
		if op == "" || invocationID == "" {
			return nil, &rpcError{-32602, "invalid runtime.invoke params"}
		}
		result, err := r.invoke(op, invocationID, payload)
		if err != nil {
			return nil, &rpcError{-32602, err.Error()}
		}
		return result, nil
	case "runtime.shutdown":
		return map[string]any{"stopping": true}, nil
	default:
		return nil, &rpcError{-32601, "method not found"}
	}
}

func (r *runtime) invoke(op, invocationID string, payload pluginjson.Raw) (any, error) {
	switch op {
	case "state":
		return r.stateResult(payload)
	case "action":
		return r.action(invocationID, payload)
	case "job":
		return r.job(payload)
	case "event":
		// 本插件不订阅事件；宿主派发时明确接受即可。
		return map[string]any{"accepted": true}, nil
	default:
		return nil, errors.New("unsupported invocation op: " + op)
	}
}

func (r *runtime) stateResult(payload pluginjson.Raw) (any, error) {
	if pluginjson.Field(payload, "view") == nil {
		return nil, errors.New("invalid state payload")
	}
	r.snap.mu.Lock()
	current := r.snap
	items := append([]chartItem(nil), current.items...)
	version := current.version
	chart := current.chart
	subscribed := current.subscribed
	updatedAt := current.updatedAt
	r.snap.mu.Unlock()

	versionText := "state-v" + pluginjson.Number(version)
	etag := `"` + versionText + `"`
	if pluginjson.Text(pluginjson.Field(payload, "if_none_match")) == etag {
		return map[string]any{"not_modified": true, "etag": etag}, nil
	}
	catalog := make([]any, 0, len(chartCatalog))
	for _, entry := range chartCatalog {
		catalog = append(catalog, map[string]any{
			"key": entry.Key, "label": entry.Label, "selected": entry.Key == chart,
		})
	}
	return map[string]any{
		"state_version": versionText,
		"etag":          etag,
		"state": map[string]any{
			"chart": chart, "subscribed": subscribed, "updated_at": updatedAt,
			"catalog": catalog, "items": encodeItems(items),
		},
	}, nil
}

func encodeItems(items []chartItem) []any {
	encoded := make([]any, 0, len(items))
	for _, item := range items {
		encoded = append(encoded, map[string]any{
			"id": item.ID, "title": item.Title, "year": item.Year,
			"rating": item.Rating, "url": item.URL,
		})
	}
	return encoded
}

func (r *runtime) action(invocationID string, payload pluginjson.Raw) (any, error) {
	actionID := pluginjson.Text(pluginjson.Field(payload, "id"))
	input := pluginjson.Field(payload, "input")
	switch actionID {
	case "refresh":
		newItems, err := r.refresh()
		if err != nil {
			return map[string]any{"status": "failed", "message": err.Error()}, nil
		}
		return map[string]any{"status": "succeeded", "message": "榜单已更新", "count": len(newItems)}, nil
	case "select":
		key := strings.TrimSpace(pluginjson.Text(pluginjson.Field(input, "chart")))
		if _, _, ok := chartCollection(key); !ok {
			return map[string]any{"status": "failed", "message": "未知榜单"}, nil
		}
		r.snap.mu.Lock()
		r.snap.chart = key
		r.snap.items = nil
		r.snap.seen = map[string]bool{}
		r.snap.version++
		r.snap.mu.Unlock()
		if err := r.persist(); err != nil {
			return map[string]any{"status": "failed", "message": err.Error()}, nil
		}
		if _, err := r.refresh(); err != nil {
			return map[string]any{"status": "failed", "message": err.Error()}, nil
		}
		return map[string]any{"status": "succeeded", "message": "已切换榜单"}, nil
	case "subscribe":
		r.snap.mu.Lock()
		r.snap.subscribed = true
		r.snap.mu.Unlock()
		if err := r.persist(); err != nil {
			return map[string]any{"status": "failed", "message": err.Error()}, nil
		}
		// 订阅时先建立基线，避免第一次定时复查把所有条目都当成新片推送。
		if _, err := r.refresh(); err != nil {
			return map[string]any{"status": "failed", "message": err.Error()}, nil
		}
		return map[string]any{"status": "succeeded", "message": "已订阅，之后有新片会通知你"}, nil
	case "unsubscribe":
		r.snap.mu.Lock()
		r.snap.subscribed = false
		r.snap.mu.Unlock()
		if err := r.persist(); err != nil {
			return map[string]any{"status": "failed", "message": err.Error()}, nil
		}
		return map[string]any{"status": "succeeded", "message": "已取消订阅"}, nil
	default:
		return map[string]any{"status": "failed", "code": "unknown_action", "message": "未知动作"}, nil
	}
}

func (r *runtime) job(payload pluginjson.Raw) (any, error) {
	if pluginjson.Text(pluginjson.Field(payload, "id")) != "poll" {
		return map[string]any{"status": "skipped", "message": "未声明的任务"}, nil
	}
	r.snap.mu.Lock()
	subscribed := r.snap.subscribed
	chart := r.snap.chart
	r.snap.mu.Unlock()
	if !subscribed {
		return map[string]any{"status": "skipped", "message": "尚未订阅"}, nil
	}
	fresh, err := r.refresh()
	if err != nil {
		return nil, err
	}
	if len(fresh) == 0 {
		return map[string]any{"status": "accepted", "message": "没有新条目", "count": 0}, nil
	}
	_, label, _ := chartCollection(chart)
	body := "《" + fresh[0].Title + "》"
	if len(fresh) > 1 {
		body += " 等 " + pluginjson.Number(len(fresh)) + " 部"
	}
	if err := r.notify(label+"有新条目", body); err != nil {
		return nil, err
	}
	return map[string]any{"status": "accepted", "count": len(fresh)}, nil
}

// refresh 拉取当前榜单，返回相对上次快照新增的条目，并把新条目并入已见集合。
func (r *runtime) refresh() ([]chartItem, error) {
	r.snap.mu.Lock()
	chart := r.snap.chart
	r.snap.mu.Unlock()
	collection, _, ok := chartCollection(chart)
	if !ok {
		return nil, errors.New("未知榜单")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	url := chartBase + collection + "/items?start=0&count=20&items_only=1&for_mobile=1"
	// 豆瓣移动端接口要求移动站来源，插件通过 Broker 显式声明 Referer。
	result, err := r.broker(ctx, "GET", url, map[string]string{
		"accept": "application/json", "referer": "https://m.douban.com/",
	}, nil)
	if err != nil {
		return nil, err
	}
	if result.status != 200 {
		return nil, errors.New("豆瓣返回 HTTP " + pluginjson.Number(result.status))
	}
	items, err := parseChart(result.body)
	if err != nil {
		return nil, err
	}
	fresh := make([]chartItem, 0)
	r.snap.mu.Lock()
	for _, item := range items {
		if !r.snap.seen[item.ID] {
			fresh = append(fresh, item)
		}
	}
	r.snap.items = items
	for _, item := range items {
		r.snap.seen[item.ID] = true
	}
	r.snap.updatedAt = time.Now().UTC().Format(time.RFC3339)
	r.snap.version++
	r.snap.mu.Unlock()
	if err := r.persist(); err != nil {
		return nil, err
	}
	return fresh, nil
}

// parseChart 只读需要的字段，不解析整个文档。
func parseChart(body []byte) ([]chartItem, error) {
	list := pluginjson.Field(body, "subject_collection_items")
	if list == nil {
		return nil, errors.New("榜单响应中没有条目")
	}
	items := make([]chartItem, 0, 20)
	for position := 0; ; position++ {
		entry := pluginjson.Index(list, position)
		if entry == nil {
			break
		}
		item := chartItem{
			ID:     pluginjson.Text(pluginjson.Field(entry, "id")),
			Title:  pluginjson.Text(pluginjson.Field(entry, "title")),
			Year:   pluginjson.Text(pluginjson.Field(entry, "year")),
			Rating: pluginjson.Text(pluginjson.Field(pluginjson.Field(entry, "rating"), "value")),
			URL:    pluginjson.Text(pluginjson.Field(entry, "url")),
		}
		if item.ID == "" {
			item.ID = item.Title
		}
		if item.ID == "" {
			continue
		}
		items = append(items, item)
	}
	return items, nil
}

func (r *runtime) persist() error {
	r.snap.mu.Lock()
	seen := make([]any, 0, len(r.snap.seen))
	for id := range r.snap.seen {
		seen = append(seen, id)
	}
	document := map[string]any{
		"chart": r.snap.chart, "subscribed": r.snap.subscribed,
		"updated_at": r.snap.updatedAt, "version": r.snap.version,
		"seen": seen, "items": encodeItems(append([]chartItem(nil), r.snap.items...)),
	}
	r.snap.mu.Unlock()
	payload, err := pluginjson.Encode(map[string]any{"value": document})
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	result, err := r.broker(ctx, "PUT", storagePath, map[string]string{
		"content-type": "application/json", "idempotency-key": "douban-chart-state",
	}, payload)
	if err != nil {
		return err
	}
	if result.status >= 400 {
		return errors.New("保存订阅状态失败（HTTP " + pluginjson.Number(result.status) + "）")
	}
	return nil
}

func (r *runtime) restore() error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	result, err := r.broker(ctx, "GET", storagePath, map[string]string{"accept": "application/json"}, nil)
	if err != nil {
		return err
	}
	if result.status == 404 {
		return nil
	}
	if result.status != 200 {
		return errors.New("读取订阅状态失败（HTTP " + pluginjson.Number(result.status) + "）")
	}
	value := pluginjson.Field(pluginjson.Field(result.body, "data"), "value")
	if value == nil {
		return errors.New("订阅状态格式不正确")
	}
	r.snap.mu.Lock()
	defer r.snap.mu.Unlock()
	if chart := pluginjson.Text(pluginjson.Field(value, "chart")); chart != "" {
		if _, _, ok := chartCollection(chart); ok {
			r.snap.chart = chart
		}
	}
	r.snap.subscribed = pluginjson.Bool(pluginjson.Field(value, "subscribed"))
	r.snap.updatedAt = pluginjson.Text(pluginjson.Field(value, "updated_at"))
	r.snap.version = pluginjson.Int(pluginjson.Field(value, "version"))
	if seen := pluginjson.Field(value, "seen"); seen != nil {
		r.snap.seen = map[string]bool{}
		for position := 0; ; position++ {
			entry := pluginjson.Index(seen, position)
			if entry == nil {
				break
			}
			if id := pluginjson.Text(entry); id != "" {
				r.snap.seen[id] = true
			}
		}
	}
	if items := pluginjson.Field(value, "items"); items != nil {
		restored := make([]chartItem, 0, 20)
		for position := 0; ; position++ {
			entry := pluginjson.Index(items, position)
			if entry == nil {
				break
			}
			restored = append(restored, chartItem{
				ID:     pluginjson.Text(pluginjson.Field(entry, "id")),
				Title:  pluginjson.Text(pluginjson.Field(entry, "title")),
				Year:   pluginjson.Text(pluginjson.Field(entry, "year")),
				Rating: pluginjson.Text(pluginjson.Field(entry, "rating")),
				URL:    pluginjson.Text(pluginjson.Field(entry, "url")),
			})
		}
		r.snap.items = restored
	}
	return nil
}

func (r *runtime) notify(title, body string) error {
	payload, err := pluginjson.Encode(map[string]any{
		"level": "info", "title": title, "body": body,
		"dedupe_key": "douban-chart-" + title + "-" + body,
	})
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	result, err := r.broker(ctx, "POST", notifyPath, map[string]string{
		"content-type": "application/json", "idempotency-key": "douban-chart-notify",
	}, payload)
	if err != nil {
		return err
	}
	if result.status >= 400 {
		return errors.New("发送通知失败（HTTP " + pluginjson.Number(result.status) + "）")
	}
	return nil
}

func (r *runtime) log(level, message string, cause error) {
	fields := map[string]any{}
	if cause != nil {
		fields["reason"] = cause.Error()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, _ = r.peer.call(ctx, "host.log", map[string]any{"level": level, "message": message, "fields": fields})
}

func main() {}
