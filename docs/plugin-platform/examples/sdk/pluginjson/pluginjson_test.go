package pluginjson

import (
	"encoding/json"
	"reflect"
	"testing"
)

// The reference runtimes replaced encoding/json with this package, so it is
// checked against encoding/json itself: anything this package writes must read
// back as the same value, and anything it reads must agree with a real decoder.

func TestEncodeRoundTripsThroughEncodingJSON(t *testing.T) {
	cases := []any{
		nil,
		true,
		0,
		42,
		"",
		"hello",
		"中文 with \"quotes\" and \\ and \n newline",
		map[string]any{"kind": "status", "ok": true, "count": 3},
		map[string]any{"nested": map[string]any{"list": []any{1, "two", false, nil}}},
		map[string]any{"buttons": []any{[]any{map[string]any{"text": "查询状态", "callback_data": "status"}}}},
		map[string]string{"content-type": "application/json"},
	}
	// Numbers decode back as float64, so compare against the same trip through
	// encoding/json instead of the original Go value.
	normalize := func(value any) any {
		encoded, err := json.Marshal(value)
		if err != nil {
			t.Fatalf("normalize %#v: %v", value, err)
		}
		var decoded any
		if err := json.Unmarshal(encoded, &decoded); err != nil {
			t.Fatalf("normalize %#v: %v", value, err)
		}
		return decoded
	}
	for _, value := range cases {
		encoded, err := Encode(value)
		if err != nil {
			t.Fatalf("Encode(%#v): %v", value, err)
		}
		var decoded any
		if err := json.Unmarshal(encoded, &decoded); err != nil {
			t.Fatalf("Encode(%#v) produced invalid JSON %s: %v", value, encoded, err)
		}
		if expected := normalize(value); !reflect.DeepEqual(decoded, expected) {
			t.Fatalf("Encode(%#v) = %s, decoded %#v, want %#v", value, encoded, decoded, expected)
		}
	}
}

// Raw passes an already-encoded value through untouched, which is how the
// runtime embeds a value it built earlier without decoding it again.
func TestEncodePassesRawThrough(t *testing.T) {
	encoded, err := Encode(map[string]any{"value": Raw(`{"saved_by":"complete-plugin"}`)})
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != `{"value":{"saved_by":"complete-plugin"}}` {
		t.Fatalf("encoded = %s", encoded)
	}
}

func TestEncodeIsStableForMapKeys(t *testing.T) {
	first, err := Encode(map[string]any{"b": 1, "a": 2, "c": 3})
	if err != nil {
		t.Fatal(err)
	}
	second, err := Encode(map[string]any{"c": 3, "a": 2, "b": 1})
	if err != nil {
		t.Fatal(err)
	}
	if string(first) != string(second) {
		t.Fatalf("map encoding is not stable: %s vs %s", first, second)
	}
}

func TestFieldReadsTheSameValueAsEncodingJSON(t *testing.T) {
	document := []byte(`{"method":"runtime.invoke","params":{"envelope":{"op":"action","invocation_id":"inv_1","payload":{"id":"fetch-local","input":{"url":"http://example.invalid/a?b=1","label":"中文"}}},"background":true},"empty":null}`)
	var generic map[string]any
	if err := json.Unmarshal(document, &generic); err != nil {
		t.Fatal(err)
	}
	if got := Text(Field(document, "method")); got != "runtime.invoke" {
		t.Fatalf("method = %q", got)
	}
	envelope := Field(Field(Field(document, "params"), "envelope"), "payload")
	if got := Text(Field(envelope, "id")); got != "fetch-local" {
		t.Fatalf("payload.id = %q", got)
	}
	input := Field(envelope, "input")
	if got := Text(Field(input, "url")); got != "http://example.invalid/a?b=1" {
		t.Fatalf("input.url = %q", got)
	}
	if got := Text(Field(input, "label")); got != "中文" {
		t.Fatalf("input.label = %q", got)
	}
	if got := Bool(Field(Field(document, "params"), "background")); !got {
		t.Fatal("background should be true")
	}
	if value := Field(document, "empty"); string(value) != "null" {
		t.Fatalf("empty = %q, want null", value)
	}
	if value := Field(document, "missing"); value != nil {
		t.Fatalf("missing field = %q, want nil", value)
	}
	if got := Int(Field([]byte(`{"count":17}`), "count")); got != 17 {
		t.Fatalf("count = %d", got)
	}
}

func TestTextDecodesEscapesLikeEncodingJSON(t *testing.T) {
	for _, document := range []string{
		`"plain"`,
		`"quote \" backslash \\ slash \/ tab \t newline \n"`,
		`"\u4e2d\u6587"`,
		`"\ud83d\ude00"`,
		`"\u00e9"`,
	} {
		var expected string
		if err := json.Unmarshal([]byte(document), &expected); err != nil {
			t.Fatalf("encoding/json rejected %s: %v", document, err)
		}
		if got := Text(Raw(document)); got != expected {
			t.Fatalf("Text(%s) = %q, want %q", document, got, expected)
		}
	}
}

func TestIndexReadsArrayElements(t *testing.T) {
	array := Raw(`[{"a":1},"two",[3,4]]`)
	var expected []any
	if err := json.Unmarshal(array, &expected); err != nil {
		t.Fatal(err)
	}
	if got := Int(Field(Index(array, 0), "a")); got != 1 {
		t.Fatalf("element 0.a = %d", got)
	}
	if got := Text(Index(array, 1)); got != "two" {
		t.Fatalf("element 1 = %q", got)
	}
	if got := Int(Index(Index(array, 2), 1)); got != 4 {
		t.Fatalf("element 2[1] = %d", got)
	}
	if got := Index(array, 3); got != nil {
		t.Fatalf("element 3 = %q, want nil", got)
	}
}

func TestFieldsReadsEveryTopLevelField(t *testing.T) {
	fields := Fields(Raw(`{"status":200,"headers":{"ETag":["\"v1\""],"content-type":["application/json"]},"empty":null}`))
	if len(fields) != 3 {
		t.Fatalf("fields = %#v", fields)
	}
	if got := Int(fields["status"]); got != 200 {
		t.Fatalf("status = %d", got)
	}
	headers := fields["headers"]
	etag := Index(Field(headers, "ETag"), 0)
	var expected string
	if err := json.Unmarshal(etag, &expected); err != nil || expected != `"v1"` {
		t.Fatalf("ETag = %q (%v)", etag, err)
	}
	if Fields(Raw(`[1,2]`)) != nil {
		t.Fatal("Fields of an array must be nil")
	}
}

func TestFieldRejectsMalformedDocuments(t *testing.T) {
	for _, document := range []string{"", "[]", "{", `{"a"`, `{"a":}`, `{"a":"unterminated}`} {
		if value := Field(Raw(document), "a"); value != nil {
			t.Fatalf("Field(%q) = %q, want nil", document, value)
		}
	}
}
