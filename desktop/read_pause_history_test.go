package main

import (
	"testing"

	"reasonix/internal/event"
	"reasonix/internal/provider"
)

func TestReadPauseHistoryAndTopic(t *testing.T) {
	p := &provider.ReadPause{ID: "run", Reads: []provider.PausedRead{{Path: "file", Reason: "no_progress"}}}
	rows, ok := historyLocalOnlyRows(provider.Message{LocalOnly: true, ReadPause: p})
	if !ok || len(rows) != 1 || rows[0].Code != event.TurnOutcomeIncompleteRead || rows[0].ReadPause.ID != "run" {
		t.Fatal("pause not restored as one notice")
	}
	if status, ok := topicStatusFromTurnDone(event.TurnOutcomeIncompleteRead); !ok || status != topicStatusPaused {
		t.Fatal("read pause classified as success")
	}
}
