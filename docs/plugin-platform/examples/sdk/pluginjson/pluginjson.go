// Package pluginjson is the small JSON layer the runtime uses instead of
// encoding/json.
//
// The host accepts modules from a size-optimising toolchain, and encoding/json
// is by far the biggest thing a Go plugin can pull in: measured on the shipped
// example it adds about 1 MB to the compiled module, which the host then keeps
// as compiled code for as long as the plugin is loaded. A plugin only ever
// needs to read a handful of known fields and to write a handful of known
// shapes, so this package covers exactly that:
//
//   - Field/Index read a raw sub-value without decoding the whole document;
//   - Text/Int/Bool decode the scalars a plugin reads;
//   - Encode writes the map/slice/string/number shapes a plugin builds;
//   - Raw passes an already-encoded value through untouched.
//
// It deliberately has no reflection and no struct tags. A plugin that needs
// general JSON can still import encoding/json and pay the size, but the host
// refuses such a module, so this package is the supported path.
//
// It lives in examples/sdk so the example plugins share one implementation
// instead of carrying copies that drift apart.
package pluginjson

import (
	"errors"
	"strings"
	"unicode/utf8"
)

// Raw is an encoded JSON value that has not been decoded yet.
type Raw []byte

// Field returns the raw value of a top-level object field. It returns nil when
// the value is not an object, the field is absent, or the document is
// malformed. The result aliases the input, so callers must not modify it.
func Field(object Raw, key string) Raw {
	data := []byte(object)
	index := skipSpace(data, 0)
	if index >= len(data) || data[index] != '{' {
		return nil
	}
	index++
	for {
		index = skipSpace(data, index)
		if index >= len(data) || data[index] == '}' {
			return nil
		}
		if data[index] != '"' {
			return nil
		}
		nameEnd, ok := scanString(data, index)
		if !ok {
			return nil
		}
		name, ok := unquote(data[index:nameEnd])
		if !ok {
			return nil
		}
		index = skipSpace(data, nameEnd)
		if index >= len(data) || data[index] != ':' {
			return nil
		}
		index = skipSpace(data, index+1)
		valueEnd, ok := scanValue(data, index)
		if !ok {
			return nil
		}
		if name == key {
			return Raw(strings.TrimSpace(string(data[index:valueEnd])))
		}
		index = skipSpace(data, valueEnd)
		if index < len(data) && data[index] == ',' {
			index++
			continue
		}
		return nil
	}
}

// Index returns the raw value of an array element, or nil when it is absent.
func Index(array Raw, position int) Raw {
	data := []byte(array)
	index := skipSpace(data, 0)
	if index >= len(data) || data[index] != '[' {
		return nil
	}
	index++
	for current := 0; ; current++ {
		index = skipSpace(data, index)
		if index >= len(data) || data[index] == ']' {
			return nil
		}
		valueEnd, ok := scanValue(data, index)
		if !ok {
			return nil
		}
		if current == position {
			return Raw(strings.TrimSpace(string(data[index:valueEnd])))
		}
		index = skipSpace(data, valueEnd)
		if index < len(data) && data[index] == ',' {
			index++
			continue
		}
		return nil
	}
}

// Fields returns every top-level field of an object as raw values. It returns
// nil when the value is not an object.
func Fields(object Raw) map[string]Raw {
	data := []byte(object)
	index := skipSpace(data, 0)
	if index >= len(data) || data[index] != '{' {
		return nil
	}
	index++
	fields := make(map[string]Raw)
	for {
		index = skipSpace(data, index)
		if index >= len(data) || data[index] == '}' {
			return fields
		}
		if data[index] != '"' {
			return nil
		}
		nameEnd, ok := scanString(data, index)
		if !ok {
			return nil
		}
		name, ok := unquote(data[index:nameEnd])
		if !ok {
			return nil
		}
		index = skipSpace(data, nameEnd)
		if index >= len(data) || data[index] != ':' {
			return nil
		}
		index = skipSpace(data, index+1)
		valueEnd, ok := scanValue(data, index)
		if !ok {
			return nil
		}
		fields[name] = Raw(strings.TrimSpace(string(data[index:valueEnd])))
		index = skipSpace(data, valueEnd)
		if index < len(data) && data[index] == ',' {
			index++
			continue
		}
	}
}

// Text decodes a JSON string. Anything that is not a string decodes to "".
func Text(value Raw) string {
	text, _ := unquote([]byte(value))
	return text
}

// Int decodes a JSON number. A non-numeric value decodes to 0.
func Int(value Raw) int {
	number, _ := parseInt(strings.TrimSpace(string(value)))
	return number
}

// Number renders an integer the way JSON does. The runtime uses it instead of
// strconv: strconv also carries float formatting, which a plugin never needs
// and which costs more than the rest of this package together.
func Number(value int) string {
	return string(appendInt(nil, int64(value)))
}

// Bool decodes a JSON literal. Anything that is not true decodes to false.
func Bool(value Raw) bool {
	return strings.TrimSpace(string(value)) == "true"
}

// Encode writes a value as JSON. It supports nil, bool, string, int, int64,
// float64, Raw, map[string]any, map[string]string and []any, which is every
// shape a plugin needs. Values nest freely.
func Encode(value any) ([]byte, error) {
	buffer := make([]byte, 0, 256)
	return appendValue(buffer, value)
}

func appendValue(buffer []byte, value any) ([]byte, error) {
	switch typed := value.(type) {
	case nil:
		return append(buffer, "null"...), nil
	case bool:
		if typed {
			return append(buffer, "true"...), nil
		}
		return append(buffer, "false"...), nil
	case string:
		return appendQuoted(buffer, typed), nil
	case int:
		return appendInt(buffer, int64(typed)), nil
	case int64:
		return appendInt(buffer, typed), nil
	case Raw:
		if len(typed) == 0 {
			return append(buffer, "null"...), nil
		}
		return append(buffer, typed...), nil
	case map[string]any:
		return appendObject(buffer, typed)
	case map[string]string:
		ordered := make(map[string]any, len(typed))
		for key, item := range typed {
			ordered[key] = item
		}
		return appendObject(buffer, ordered)
	case []any:
		buffer = append(buffer, '[')
		for position, item := range typed {
			if position > 0 {
				buffer = append(buffer, ',')
			}
			next, err := appendValue(buffer, item)
			if err != nil {
				return nil, err
			}
			buffer = next
		}
		return append(buffer, ']'), nil
	default:
		return nil, errors.New("pluginjson: unsupported value type")
	}
}

func appendObject(buffer []byte, object map[string]any) ([]byte, error) {
	// Keys are sorted so the same value always produces the same bytes, which
	// keeps request hashes and idempotency keys stable across calls.
	keys := make([]string, 0, len(object))
	for key := range object {
		keys = append(keys, key)
	}
	sortStrings(keys)
	buffer = append(buffer, '{')
	for position, key := range keys {
		if position > 0 {
			buffer = append(buffer, ',')
		}
		buffer = appendQuoted(buffer, key)
		buffer = append(buffer, ':')
		next, err := appendValue(buffer, object[key])
		if err != nil {
			return nil, err
		}
		buffer = next
	}
	return append(buffer, '}'), nil
}

func appendQuoted(buffer []byte, text string) []byte {
	buffer = append(buffer, '"')
	for index := 0; index < len(text); {
		character := text[index]
		if character < utf8.RuneSelf {
			switch character {
			case '"', '\\':
				buffer = append(buffer, '\\', character)
			case '\n':
				buffer = append(buffer, '\\', 'n')
			case '\r':
				buffer = append(buffer, '\\', 'r')
			case '\t':
				buffer = append(buffer, '\\', 't')
			default:
				if character < 0x20 {
					buffer = append(buffer, '\\', 'u', '0', '0', hexDigits[character>>4], hexDigits[character&0x0f])
				} else {
					buffer = append(buffer, character)
				}
			}
			index++
			continue
		}
		_, size := utf8.DecodeRuneInString(text[index:])
		buffer = append(buffer, text[index:index+size]...)
		index += size
	}
	return append(buffer, '"')
}

// appendInt writes a JSON integer without going through strconv.
func appendInt(buffer []byte, value int64) []byte {
	if value == 0 {
		return append(buffer, '0')
	}
	if value < 0 {
		buffer = append(buffer, '-')
		// Negate in the unsigned space so the most negative value is safe.
		return appendUint(buffer, uint64(-(value + 1))+1)
	}
	return appendUint(buffer, uint64(value))
}

func appendUint(buffer []byte, value uint64) []byte {
	var digits [20]byte
	position := len(digits)
	for value > 0 {
		position--
		digits[position] = byte('0' + value%10)
		value /= 10
	}
	return append(buffer, digits[position:]...)
}

// parseInt reads a plain JSON integer. Scientific notation and fractions are
// rejected, which is what the host sends for the counters a plugin reads.
func parseInt(text string) (int, bool) {
	if text == "" {
		return 0, false
	}
	index := 0
	negative := false
	switch text[0] {
	case '-':
		negative = true
		index = 1
	case '+':
		index = 1
	}
	if index >= len(text) {
		return 0, false
	}
	value := 0
	for ; index < len(text); index++ {
		digit := text[index]
		if digit < '0' || digit > '9' {
			return 0, false
		}
		value = value*10 + int(digit-'0')
	}
	if negative {
		value = -value
	}
	return value, true
}

const hexDigits = "0123456789abcdef"

func skipSpace(data []byte, index int) int {
	for index < len(data) {
		switch data[index] {
		case ' ', '\t', '\n', '\r':
			index++
		default:
			return index
		}
	}
	return index
}

// scanString returns the index just past the closing quote of the string that
// starts at index.
func scanString(data []byte, index int) (int, bool) {
	if index >= len(data) || data[index] != '"' {
		return 0, false
	}
	for cursor := index + 1; cursor < len(data); cursor++ {
		switch data[cursor] {
		case '\\':
			cursor++
		case '"':
			return cursor + 1, true
		}
	}
	return 0, false
}

// scanValue returns the index just past the value that starts at index.
func scanValue(data []byte, index int) (int, bool) {
	if index >= len(data) {
		return 0, false
	}
	switch data[index] {
	case '"':
		return scanString(data, index)
	case '{', '[':
		open := data[index]
		close := byte('}')
		if open == '[' {
			close = ']'
		}
		depth := 0
		for cursor := index; cursor < len(data); cursor++ {
			switch data[cursor] {
			case '"':
				end, ok := scanString(data, cursor)
				if !ok {
					return 0, false
				}
				cursor = end - 1
			case open:
				depth++
			case close:
				depth--
				if depth == 0 {
					return cursor + 1, true
				}
			}
		}
		return 0, false
	default:
		cursor := index
		for cursor < len(data) {
			switch data[cursor] {
			case ',', '}', ']', ' ', '\t', '\n', '\r':
				return cursor, cursor != index
			case '{', '[':
				return 0, false
			}
			cursor++
		}
		return cursor, true
	}
}

// unquote decodes a JSON string, including \u escapes and surrogate pairs.
func unquote(data []byte) (string, bool) {
	data = []byte(strings.TrimSpace(string(data)))
	if len(data) < 2 || data[0] != '"' || data[len(data)-1] != '"' {
		return "", false
	}
	body := data[1 : len(data)-1]
	if !hasEscape(body) {
		return string(body), true
	}
	builder := make([]byte, 0, len(body))
	for index := 0; index < len(body); {
		if body[index] != '\\' {
			builder = append(builder, body[index])
			index++
			continue
		}
		if index+1 >= len(body) {
			return "", false
		}
		switch body[index+1] {
		case '"', '\\', '/':
			builder = append(builder, body[index+1])
			index += 2
		case 'b':
			builder = append(builder, '\b')
			index += 2
		case 'f':
			builder = append(builder, '\f')
			index += 2
		case 'n':
			builder = append(builder, '\n')
			index += 2
		case 'r':
			builder = append(builder, '\r')
			index += 2
		case 't':
			builder = append(builder, '\t')
			index += 2
		case 'u':
			decoded, size, ok := decodeUnicodeEscape(body[index:])
			if !ok {
				return "", false
			}
			builder = append(builder, decoded...)
			index += size
		default:
			return "", false
		}
	}
	return string(builder), true
}

func hasEscape(data []byte) bool {
	for _, character := range data {
		if character == '\\' {
			return true
		}
	}
	return false
}

func decodeUnicodeEscape(data []byte) ([]byte, int, bool) {
	if len(data) < 6 || data[0] != '\\' || data[1] != 'u' {
		return nil, 0, false
	}
	code, ok := hex16(data[2:6])
	if !ok {
		return nil, 0, false
	}
	// A high surrogate must be followed by its low surrogate.
	if code >= 0xd800 && code <= 0xdbff {
		if len(data) < 12 || data[6] != '\\' || data[7] != 'u' {
			return []byte("\uFFFD"), 6, true
		}
		low, ok := hex16(data[8:12])
		if !ok || low < 0xdc00 || low > 0xdfff {
			return []byte("\uFFFD"), 6, true
		}
		combined := rune(0x10000 + (code-0xd800)<<10 + (low - 0xdc00))
		return []byte(string(combined)), 12, true
	}
	if code >= 0xdc00 && code <= 0xdfff {
		return []byte("\uFFFD"), 6, true
	}
	return []byte(string(rune(code))), 6, true
}

func hex16(data []byte) (int, bool) {
	if len(data) != 4 {
		return 0, false
	}
	value := 0
	for _, character := range data {
		value <<= 4
		switch {
		case character >= '0' && character <= '9':
			value |= int(character - '0')
		case character >= 'a' && character <= 'f':
			value |= int(character-'a') + 10
		case character >= 'A' && character <= 'F':
			value |= int(character-'A') + 10
		default:
			return 0, false
		}
	}
	return value, true
}

// sortStrings is a small insertion sort: object keys are few, and this avoids
// pulling in the sort package for the reference runtime.
func sortStrings(values []string) {
	for index := 1; index < len(values); index++ {
		for cursor := index; cursor > 0 && values[cursor] < values[cursor-1]; cursor-- {
			values[cursor], values[cursor-1] = values[cursor-1], values[cursor]
		}
	}
}
