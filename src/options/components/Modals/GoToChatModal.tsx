import React, { useEffect, useState } from "react";
import { Button } from "../../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";

interface GoToChatModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (chatId: string) => Promise<void> | void;
}

export const GoToChatModal = ({ open, onOpenChange, onConfirm }: GoToChatModalProps) => {
  const [chatId, setChatId] = useState("");
  const [isOpening, setIsOpening] = useState(false);

  useEffect(() => {
    if (!open) return;
    setChatId("");
    setIsOpening(false);
  }, [open]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedChatId = chatId.trim();
    if (!trimmedChatId || isOpening) return;

    setIsOpening(true);
    try {
      await onConfirm(trimmedChatId);
      onOpenChange(false);
    } finally {
      setIsOpening(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Go to chat</DialogTitle>
          <DialogDescription>Enter a chat ID to open it in the viewer.</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            value={chatId}
            onChange={(e) => setChatId((e.target as HTMLInputElement).value)}
            placeholder="chat_123..."
            autoFocus
          />

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={isOpening}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!chatId.trim() || isOpening}>
              Open
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
