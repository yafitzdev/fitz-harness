import { useState } from "react";

export interface Todo {
  id: number;
  title: string;
  done: boolean;
}

interface TodoListProps {
  initial: Todo[];
  onToggle?: (id: number) => void;
}

export function TodoList({ initial, onToggle }: TodoListProps) {
  const [todos, setTodos] = useState<Todo[]>(initial);

  const addTodo = (title: string) => {
    const next: Todo = { id: Date.now(), title, done: false };
    setTodos([...todos, next]);
  };

  return (
    <ul>
      {todos.map((todo) => (
        <li key={todo.id} className={todo.done ? "done" : ""}>
          <input
            type="checkbox"
            checked={todo.done}
            onChange={() => onToggle?.(todo.id)}
          />
          {todo.title}
        </li>
      ))}
      <li>
        <button onClick={() => addTodo("new task")}>Add</button>
      </li>
    </ul>
  );
}
