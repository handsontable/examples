class CreateOrders < ActiveRecord::Migration[7.1]
  def change
    create_table :orders do |t|
      t.string  :order_number, null: false
      t.string  :customer,     null: false
      t.string  :status,       null: false
      t.decimal :total,        precision: 10, scale: 2, null: false, default: 0

      t.timestamps
    end

    add_index :orders, :order_number, unique: true
  end
end
